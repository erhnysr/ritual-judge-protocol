// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AIJudgePanel} from "../src/AIJudgePanel.sol";
import {IAIJudgeRequest} from "../src/interfaces/IAIJudgeRequest.sol";
import {IAIJudgeCallback} from "../src/interfaces/IAIJudgeCallback.sol";
import {MedianConsensus} from "../src/lib/MedianConsensus.sol";

contract AIJudgePanelTest is Test {
    AIJudgePanel panel;

    address owner = address(0xA11CE);
    address relayer = address(0xBEEF);
    address stranger = address(0xDEAD);
    address arena = address(0xC0FFEE);

    bytes32 constant CONTENT_HASH = keccak256("some entry content");
    string constant CONTENT_REF = "ipfs://Qmentry";
    string constant CRITERIA = "Score originality and wit, 0-100.";

    function setUp() public {
        vm.prank(owner);
        panel = new AIJudgePanel(relayer);
    }

    // ── open ────────────────────────────────────────────────────────

    function test_openRequest_emitsAndStores() public {
        vm.expectEmit(true, true, false, true);
        emit IAIJudgeRequest.AIJudgeRequested(1, relayer, CONTENT_HASH, CONTENT_REF, CRITERIA);

        vm.prank(relayer);
        uint256 id = panel.openRequest(arena, 0, CONTENT_HASH, CONTENT_REF, CRITERIA);

        assertEq(id, 1);
        assertEq(panel.requestIdOf(keccak256(abi.encodePacked(arena, uint256(0)))), 1);

        AIJudgePanel.JudgeRequest memory r = panel.getRequest(1);
        assertEq(r.arena, arena);
        assertEq(r.submissionId, 0);
        assertEq(r.contentHash, CONTENT_HASH);
        assertEq(uint256(r.status), uint256(AIJudgePanel.Status.Requested));
    }

    function test_openRequest_onlyRelayer() public {
        vm.prank(stranger);
        vm.expectRevert(AIJudgePanel.NotRelayer.selector);
        panel.openRequest(arena, 0, CONTENT_HASH, CONTENT_REF, CRITERIA);
    }

    function test_openRequest_duplicateReverts() public {
        vm.startPrank(relayer);
        panel.openRequest(arena, 0, CONTENT_HASH, CONTENT_REF, CRITERIA);
        vm.expectRevert(AIJudgePanel.AlreadyRequested.selector);
        panel.openRequest(arena, 0, CONTENT_HASH, CONTENT_REF, CRITERIA);
        vm.stopPrank();
    }

    function test_openRequest_zeroArenaReverts() public {
        vm.prank(relayer);
        vm.expectRevert(AIJudgePanel.ZeroAddress.selector);
        panel.openRequest(address(0), 0, CONTENT_HASH, CONTENT_REF, CRITERIA);
    }

    // ── submitScores (median-on-chain) ──────────────────────────────

    function test_submitScores_computesMedianOnChain() public {
        vm.startPrank(relayer);
        uint256 id = panel.openRequest(arena, 0, CONTENT_HASH, CONTENT_REF, CRITERIA);

        uint256[3] memory scores = [uint256(70), 92, 81];
        bytes32[3] memory hashes = [bytes32("tx0"), bytes32("tx1"), bytes32("tx2")];

        vm.expectEmit(true, false, false, true);
        emit IAIJudgeCallback.AIJudgeResult(id, 81, hashes);
        panel.submitScores(id, scores, hashes);
        vm.stopPrank();

        (bool judged, uint256 median, uint256 rid) = panel.scoreOf(arena, 0);
        assertTrue(judged);
        assertEq(median, 81);
        assertEq(rid, id);
        assertEq(panel.getScores(id)[1], 92);
        assertEq(panel.getRitualTxHashes(id)[2], bytes32("tx2"));
    }

    function test_submitScores_outOfRangeReverts() public {
        vm.startPrank(relayer);
        uint256 id = panel.openRequest(arena, 0, CONTENT_HASH, CONTENT_REF, CRITERIA);
        uint256[3] memory scores = [uint256(70), 101, 81];
        vm.expectRevert(AIJudgePanel.ScoreOutOfRange.selector);
        panel.submitScores(id, scores, [bytes32(0), bytes32(0), bytes32(0)]);
        vm.stopPrank();
    }

    function test_submitScores_unknownRequestReverts() public {
        vm.prank(relayer);
        vm.expectRevert(AIJudgePanel.UnknownRequest.selector);
        panel.submitScores(999, [uint256(1), 2, 3], [bytes32(0), bytes32(0), bytes32(0)]);
    }

    function test_submitScores_doubleJudgeReverts() public {
        vm.startPrank(relayer);
        uint256 id = panel.openRequest(arena, 0, CONTENT_HASH, CONTENT_REF, CRITERIA);
        uint256[3] memory scores = [uint256(70), 92, 81];
        bytes32[3] memory hashes = [bytes32("a"), bytes32("b"), bytes32("c")];
        panel.submitScores(id, scores, hashes);
        vm.expectRevert(AIJudgePanel.NotAwaitingJudgement.selector);
        panel.submitScores(id, scores, hashes);
        vm.stopPrank();
    }

    // ── onAIJudgeResult (median off-chain, standard callback) ───────

    function test_onAIJudgeResult_recordsMedian() public {
        vm.startPrank(relayer);
        uint256 id = panel.openRequest(arena, 0, CONTENT_HASH, CONTENT_REF, CRITERIA);
        bytes32[3] memory hashes = [bytes32("a"), bytes32("b"), bytes32("c")];
        panel.onAIJudgeResult(id, 55, hashes);
        vm.stopPrank();

        (bool judged, uint256 median,) = panel.scoreOf(arena, 0);
        assertTrue(judged);
        assertEq(median, 55);
    }

    function test_onAIJudgeResult_onlyRelayer() public {
        vm.prank(relayer);
        uint256 id = panel.openRequest(arena, 0, CONTENT_HASH, CONTENT_REF, CRITERIA);
        vm.prank(stranger);
        vm.expectRevert(AIJudgePanel.NotRelayer.selector);
        panel.onAIJudgeResult(id, 55, [bytes32(0), bytes32(0), bytes32(0)]);
    }

    // ── admin ───────────────────────────────────────────────────────

    function test_setRelayer() public {
        vm.prank(owner);
        panel.setRelayer(stranger, true);
        assertTrue(panel.isRelayer(stranger));

        vm.prank(stranger);
        panel.openRequest(arena, 1, CONTENT_HASH, CONTENT_REF, CRITERIA);
    }

    function test_setRelayer_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(AIJudgePanel.NotOwner.selector);
        panel.setRelayer(stranger, true);
    }

    function test_scoreOf_unopenedReturnsZero() public view {
        (bool judged, uint256 median, uint256 rid) = panel.scoreOf(arena, 42);
        assertFalse(judged);
        assertEq(median, 0);
        assertEq(rid, 0);
    }

    // ── median library ──────────────────────────────────────────────

    function testFuzz_medianOf3(uint8 a, uint8 b, uint8 c) public pure {
        uint256[3] memory s = [uint256(a), uint256(b), uint256(c)];
        uint256 m = MedianConsensus.medianOf3(s);
        // median is >= min and <= max, and equals the middle of the sorted trio
        uint256 lo = a < b ? (a < c ? a : c) : (b < c ? b : c);
        uint256 hi = a > b ? (a > c ? a : c) : (b > c ? b : c);
        assertGe(m, lo);
        assertLe(m, hi);
        assertEq(m, uint256(a) + uint256(b) + uint256(c) - lo - hi);
    }
}
