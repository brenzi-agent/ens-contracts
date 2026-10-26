//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice ERC1967 proxy used to deploy SimplexController behind an
///         upgrade-controlled forwarder. Identical to OZ's ERC1967Proxy;
///         declared as a concrete contract so Hardhat emits its artifact
///         and the deploy script can reference it as
///         `artifacts.SimplexControllerProxy`.
contract SimplexControllerProxy is ERC1967Proxy {
    constructor(address _logic, bytes memory _data)
        payable
        ERC1967Proxy(_logic, _data)
    {}
}
