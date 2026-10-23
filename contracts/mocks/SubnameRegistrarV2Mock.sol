//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

import {SubnameRegistrar} from "../simplex/SubnameRegistrar.sol";

/// @dev Test-only upgrade target: SubnameRegistrar plus one function, so a test
///      can tell which implementation answers.
contract SubnameRegistrarV2Mock is SubnameRegistrar {
    function version() external pure returns (uint256) {
        return 2;
    }
}
