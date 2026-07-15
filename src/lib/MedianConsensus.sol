// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MedianConsensus
/// @notice Trustless on-chain median of three AI judge scores. Querying three
///         independent TEE executors with the same prompt and taking the median
///         removes single-model bias and is robust to one outlier/faulty result.
/// @dev    Pure library: given the three raw scores, the median is fully
///         reproducible on-chain, so a consumer need not trust the relayer's
///         off-chain arithmetic — only that the three scores map to the three
///         published Ritual tx hashes (independently checkable on the explorer).
library MedianConsensus {
    /// @notice Median of exactly three values, with no branching surprises:
    ///         median = a + b + c - max - min.
    function medianOf3(uint256[3] memory scores) internal pure returns (uint256) {
        uint256 a = scores[0];
        uint256 b = scores[1];
        uint256 c = scores[2];

        uint256 max = a;
        if (b > max) max = b;
        if (c > max) max = c;

        uint256 min = a;
        if (b < min) min = b;
        if (c < min) min = c;

        // Sum can't overflow for realistic 0..100 scores; general for any uint256
        // whose triple sum fits (callers here bound scores to <= 100).
        return (a + b + c) - max - min;
    }
}
