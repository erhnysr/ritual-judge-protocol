// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAIJudgeCallback
/// @notice Chain-agnostic standard for receiving an AI judgement result back from
///         a relayer. The consumer records the final `medianScore` and the three
///         Ritual transaction hashes that produced it, so anyone can independently
///         re-verify each TEE-attested inference on the Ritual explorer.
///
/// @dev    The result carries THREE `ritualTxHashes` on purpose: this protocol's
///         consensus mechanism scores the same content with three *different*
///         registered TEE executors and takes the median, removing single-model
///         bias. A conforming consumer implements `onAIJudgeResult`; the relayer
///         (or a richer path that verifies the median on-chain) calls it exactly
///         once per `requestId`.
interface IAIJudgeCallback {
    /// @notice Emitted once a request has been judged and recorded.
    /// @param requestId      The id from the originating `AIJudgeRequested`.
    /// @param medianScore    Median of the three executor scores (0..100).
    /// @param ritualTxHashes The three Ritual tx hashes, one per executor.
    event AIJudgeResult(
        uint256 indexed requestId,
        uint256 medianScore,
        bytes32[3] ritualTxHashes
    );

    /// @notice Deliver the judged result for `requestId`.
    /// @dev    Implementations MUST reject unknown or already-judged requestIds
    ///         and SHOULD restrict the caller to an authorized relayer.
    /// @param requestId      The id from the originating `AIJudgeRequested`.
    /// @param medianScore    Median of the three executor scores (0..100).
    /// @param ritualTxHashes The three Ritual tx hashes, one per executor.
    function onAIJudgeResult(
        uint256 requestId,
        uint256 medianScore,
        bytes32[3] calldata ritualTxHashes
    ) external;
}
