// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AIJudgePanel} from "../src/AIJudgePanel.sol";

/// @notice Deploys AIJudgePanel to Arc testnet (chain 5042002).
/// @dev    Usage:
///           forge script script/DeployAIJudgePanel.s.sol \
///             --rpc-url arc_testnet --broadcast
///         Set RELAYER_ADDRESS in the environment to authorize the relayer at
///         construction; otherwise the deployer must call setRelayer afterwards.
contract DeployAIJudgePanel is Script {
    function run() external returns (AIJudgePanel panel) {
        address relayer = vm.envOr("RELAYER_ADDRESS", address(0));

        vm.startBroadcast();
        panel = new AIJudgePanel(relayer);
        vm.stopBroadcast();

        console2.log("AIJudgePanel:", address(panel));
        console2.log("owner:", panel.owner());
        console2.log("initial relayer:", relayer);
    }
}
