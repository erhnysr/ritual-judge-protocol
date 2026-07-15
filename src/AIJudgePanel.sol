// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAIJudgeRequest} from "./interfaces/IAIJudgeRequest.sol";
import {IAIJudgeCallback} from "./interfaces/IAIJudgeCallback.sol";
import {MedianConsensus} from "./lib/MedianConsensus.sol";

/// @title AIJudgePanel
/// @notice Reference implementation of the ritual-judge-protocol on Arc testnet
///         (chain 5042002). It is the first integration target for the Coliseum
///         judging market: a relayer watches Coliseum's `SubmissionCreated`
///         events, opens a judge request here (one per submission), runs the same
///         prompt against three registered Ritual TEE executors off-chain, then
///         submits the three scores back. The panel computes the median on-chain
///         and stores it alongside the three Ritual tx hashes.
///
/// @dev    READ-ONLY toward Coliseum. This contract never calls Arena.sol or
///         ArenaFactory.sol and does not require any change to them — it merely
///         records `(arena, submissionId)` so an AI score can be looked up for a
///         submission without touching Coliseum state. Any future contract can
///         reuse the same protocol by emitting `IAIJudgeRequest.AIJudgeRequested`
///         and consuming `IAIJudgeCallback`; Coliseum is just the first consumer.
contract AIJudgePanel is IAIJudgeRequest, IAIJudgeCallback {
    using MedianConsensus for uint256[3];

    /// @notice Max score any single executor may return; also caps the median.
    uint256 public constant MAX_SCORE = 100;

    enum Status {
        None, // never opened
        Requested, // opened, awaiting judgement
        Judged // median recorded
    }

    /// @dev One judge request. `arena`/`submissionId` tie it back to Coliseum
    ///      without any on-chain coupling to the Arena contract itself.
    struct JudgeRequest {
        address arena; // Coliseum Arena that emitted the submission
        uint256 submissionId; // 0-indexed submission id within that arena
        bytes32 contentHash; // integrity commitment to the judged content
        string criteria; // rubric the executors scored against
        Status status;
        uint256[3] scores; // the three raw executor scores (0 until judged)
        uint256 medianScore; // MedianConsensus.medianOf3(scores)
        bytes32[3] ritualTxHashes; // one Ritual tx per executor
        uint64 requestedAt;
        uint64 judgedAt;
    }

    address public owner;
    uint256 public nextRequestId;

    mapping(uint256 => JudgeRequest) private _requests;
    mapping(address => bool) public isRelayer;

    /// @notice Lookup a submission's request id: keccak256(arena, submissionId).
    ///         Zero means "no request opened yet". Ids are 1-based so that a real
    ///         request never collides with the zero sentinel.
    mapping(bytes32 => uint256) public requestIdOf;

    event OwnershipTransferred(address indexed from, address indexed to);
    event RelayerSet(address indexed relayer, bool allowed);
    event SubmissionLinked(
        uint256 indexed requestId,
        address indexed arena,
        uint256 indexed submissionId
    );

    error NotOwner();
    error NotRelayer();
    error ZeroAddress();
    error AlreadyRequested();
    error UnknownRequest();
    error NotAwaitingJudgement();
    error ScoreOutOfRange();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyRelayer() {
        if (!isRelayer[msg.sender]) revert NotRelayer();
        _;
    }

    constructor(address initialRelayer) {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        if (initialRelayer != address(0)) {
            isRelayer[initialRelayer] = true;
            emit RelayerSet(initialRelayer, true);
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Relayer: open a request
    // ────────────────────────────────────────────────────────────────

    /// @notice Open a judge request for one Coliseum submission. Called by the
    ///         relayer after it observes a `SubmissionCreated` event on Arc.
    /// @param arena        The Arena contract that emitted the submission.
    /// @param submissionId The 0-indexed submission id within that arena.
    /// @param contentHash  Integrity commitment to the resolved content bytes.
    /// @param contentRef   Off-chain locator (IPFS hash / URL) for the content.
    /// @param criteria     Judging rubric (typically derived from the arena topic).
    /// @return requestId   The new request id (1-based).
    function openRequest(
        address arena,
        uint256 submissionId,
        bytes32 contentHash,
        string calldata contentRef,
        string calldata criteria
    ) external onlyRelayer returns (uint256 requestId) {
        if (arena == address(0)) revert ZeroAddress();

        bytes32 key = _submissionKey(arena, submissionId);
        if (requestIdOf[key] != 0) revert AlreadyRequested();

        requestId = ++nextRequestId;
        requestIdOf[key] = requestId;

        JudgeRequest storage r = _requests[requestId];
        r.arena = arena;
        r.submissionId = submissionId;
        r.contentHash = contentHash;
        r.criteria = criteria;
        r.status = Status.Requested;
        r.requestedAt = uint64(block.timestamp);

        emit SubmissionLinked(requestId, arena, submissionId);
        // IAIJudgeRequest: the relayer keys its inference off this event.
        emit AIJudgeRequested(requestId, msg.sender, contentHash, contentRef, criteria);
    }

    // ────────────────────────────────────────────────────────────────
    // Relayer: deliver the result
    // ────────────────────────────────────────────────────────────────

    /// @notice Submit the three raw executor scores; the panel computes the median
    ///         ON-CHAIN so no one has to trust the relayer's arithmetic. This is
    ///         the recommended delivery path for this protocol.
    /// @param requestId      The request opened via `openRequest`.
    /// @param scores         The three executor scores, each in [0, MAX_SCORE].
    /// @param ritualTxHashes The three Ritual tx hashes, one per executor.
    function submitScores(
        uint256 requestId,
        uint256[3] calldata scores,
        bytes32[3] calldata ritualTxHashes
    ) external onlyRelayer {
        JudgeRequest storage r = _load(requestId);
        if (r.status != Status.Requested) revert NotAwaitingJudgement();

        for (uint256 i = 0; i < 3; i++) {
            if (scores[i] > MAX_SCORE) revert ScoreOutOfRange();
        }

        uint256[3] memory s = scores;
        uint256 median = s.medianOf3();

        r.scores = scores;
        r.medianScore = median;
        r.ritualTxHashes = ritualTxHashes;
        r.status = Status.Judged;
        r.judgedAt = uint64(block.timestamp);

        emit AIJudgeResult(requestId, median, ritualTxHashes);
    }

    /// @notice Generic `IAIJudgeCallback` path: deliver a median computed OFF-chain.
    ///         Provided for standard-compliance and for relayers that don't publish
    ///         the three raw scores. `submitScores` is preferred as it verifies the
    ///         consensus on-chain. Individual `scores` remain 0 on this path.
    /// @inheritdoc IAIJudgeCallback
    function onAIJudgeResult(
        uint256 requestId,
        uint256 medianScore,
        bytes32[3] calldata ritualTxHashes
    ) external onlyRelayer {
        if (medianScore > MAX_SCORE) revert ScoreOutOfRange();

        JudgeRequest storage r = _load(requestId);
        if (r.status != Status.Requested) revert NotAwaitingJudgement();

        r.medianScore = medianScore;
        r.ritualTxHashes = ritualTxHashes;
        r.status = Status.Judged;
        r.judgedAt = uint64(block.timestamp);

        emit AIJudgeResult(requestId, medianScore, ritualTxHashes);
    }

    // ────────────────────────────────────────────────────────────────
    // Views
    // ────────────────────────────────────────────────────────────────

    function getRequest(uint256 requestId) external view returns (JudgeRequest memory) {
        return _load(requestId);
    }

    /// @notice AI score for a Coliseum submission, if judged.
    /// @return judged     Whether a median has been recorded.
    /// @return medianScore The recorded median (0 if not judged).
    /// @return requestId  The linked request id (0 if never opened).
    function scoreOf(address arena, uint256 submissionId)
        external
        view
        returns (bool judged, uint256 medianScore, uint256 requestId)
    {
        requestId = requestIdOf[_submissionKey(arena, submissionId)];
        if (requestId == 0) return (false, 0, 0);
        JudgeRequest storage r = _requests[requestId];
        return (r.status == Status.Judged, r.medianScore, requestId);
    }

    function getScores(uint256 requestId) external view returns (uint256[3] memory) {
        return _load(requestId).scores;
    }

    function getRitualTxHashes(uint256 requestId) external view returns (bytes32[3] memory) {
        return _load(requestId).ritualTxHashes;
    }

    // ────────────────────────────────────────────────────────────────
    // Admin
    // ────────────────────────────────────────────────────────────────

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        isRelayer[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ────────────────────────────────────────────────────────────────
    // Internal
    // ────────────────────────────────────────────────────────────────

    function _submissionKey(address arena, uint256 submissionId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(arena, submissionId));
    }

    function _load(uint256 requestId) internal view returns (JudgeRequest storage r) {
        r = _requests[requestId];
        if (r.status == Status.None) revert UnknownRequest();
    }
}
