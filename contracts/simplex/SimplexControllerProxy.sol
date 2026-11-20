//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice ERC1967 proxy of the v1 SimplexController deployments, upgraded
///         through the UUPS functions of their implementation. Identical to
///         OZ's ERC1967Proxy; declared as a concrete contract so Hardhat emits
///         its artifact for the v1 deploy and verification scripts.
contract SimplexControllerProxy is ERC1967Proxy {
    constructor(address _logic, bytes memory _data)
        payable
        ERC1967Proxy(_logic, _data)
    {}
}
