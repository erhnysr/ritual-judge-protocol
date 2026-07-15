// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAIJudgeRequest
/// @notice Chain-agnostic standard for a contract that wants a piece of content
///         scored by an AI judge. A conforming contract emits `AIJudgeRequested`
///         with a unique `requestId`; an off-chain relayer watches for it, runs
///         the inference (on Ritual, TEE-verified), and delivers the result back
///         through `IAIJudgeCallback`.
///
/// @dev    The standard is intentionally minimal: it fixes only the *shape* of a
///         request, not where the requester lives or how it stores state. Any
///         contract on any chain can plug in by emitting this event. The two
///         load-bearing fields are:
///           - `contentHash`: a stable identity/integrity commitment to the
///             content being judged (e.g. keccak256 of the resolved bytes).
///           - `criteria`:    a free-text rubric the model scores against.
///         `contentRef` is the off-chain locator (IPFS hash / URL) the relayer
///         resolves to obtain the bytes to send to the model. It is separate from
///         `contentHash` so that the identity of a request does not depend on the
///         (possibly mutable) locator string.
interface IAIJudgeRequest {
    /// @notice Emitted when a contract requests an AI judgement.
    /// @param requestId  Unique, monotonic id scoped to the emitting contract.
    /// @param requester  The account/contract that originated the request.
    /// @param contentHash Integrity/identity commitment to the judged content.
    /// @param contentRef  Off-chain locator (IPFS hash or URL) for the content.
    /// @param criteria    Free-text judging rubric the model scores against.
    event AIJudgeRequested(
        uint256 indexed requestId,
        address indexed requester,
        bytes32 contentHash,
        string contentRef,
        string criteria
    );
}
