//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IETHRegistrarController, IPriceOracle} from "../ethregistrar/IETHRegistrarController.sol";
import {SimplexController} from "./SimplexController.sol";

/// @title SimplexSponsor
/// @notice The sponsored payment path: a registrar registers and renews names
///         for users against a spending limit the guardian sets, and attaches
///         no value; it registers a name to anyone but itself only with that
///         owner's `RegisterName` signature. The guardian is the controller's
///         `beneficiary`, and the controller's owner can replace this contract
///         until `freeze`.
contract SimplexSponsor {
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant _EIP712_NAME = keccak256("SimplexSponsor");
    bytes32 private constant _EIP712_VERSION = keccak256("1");
    bytes32 public constant REGISTER_TYPEHASH =
        keccak256(
            "RegisterName(string label,address owner,address resolver,bytes[] data,uint256 nonce,uint256 deadline)"
        );

    SimplexController public immutable controller;

    /// @dev Spending limit per registrar, in attoUSD. A sponsored registration or
    ///      renewal deducts the name's own list price. Denominated in the unit the
    ///      price list is configured in, so it does not move with the ETH price.
    mapping(address => uint256) public registrarAllowance;

    /// @dev One counter per signer, consumed in order, so a signature cannot be
    ///      replayed and two intents cannot be reordered.
    mapping(address => uint256) public nonces;

    event RegistrarAllowanceSet(address indexed registrar, uint256 allowanceUSD);
    event RegistrarAllowanceSpent(
        address indexed registrar,
        uint256 spentUSD,
        uint256 remainingUSD
    );

    error NotBeneficiary();
    error InsufficientAllowance(uint256 required, uint256 available);
    error SignatureExpired();
    error InvalidNonce();
    error InvalidSignature();

    constructor(SimplexController _controller) {
        controller = _controller;
    }

    /// @notice Replace a registrar's spending limit, in attoUSD. Set, not add:
    ///         zeroing it is the kill switch for a compromised registrar and must
    ///         take one transaction.
    function setRegistrarAllowance(
        address registrar,
        uint256 allowanceUSD
    ) external {
        if (msg.sender != controller.beneficiary()) revert NotBeneficiary();
        registrarAllowance[registrar] = allowanceUSD;
        emit RegistrarAllowanceSet(registrar, allowanceUSD);
    }

    /// @notice Register with no value attached, spending the name's list price
    ///         from the caller's allowance.
    /// @param sig The owner's EIP-712 `RegisterName` signature, which covers the
    ///        label, the resolver and `data`, not the secret, duration or referrer.
    ///        Not checked when the owner is the caller.
    function registerWithCredit(
        IETHRegistrarController.Registration calldata registration,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external {
        if (registration.owner != msg.sender)
            _consumeIntent(registration, nonce, deadline, sig);
        IPriceOracle.Price memory usd = controller.rentPriceUSD(
            registration.label,
            registration.duration
        );
        _spendAllowance(usd.base + usd.premium);
        controller.registerSponsored(registration);
    }

    /// @notice Renew with no value attached, spending the name's list price
    ///         from the caller's allowance.
    function renewWithCredit(
        string calldata label,
        uint256 duration,
        bytes32 referrer
    ) external {
        // Base only, matching the payable `renew`, which charges `price.base`.
        // The premium is the expired-name auction price and is owed on
        // re-registration, never on renewing a name you already hold.
        _spendAllowance(controller.rentPriceUSD(label, duration).base);
        controller.renewSponsored(label, duration, referrer);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    _EIP712_DOMAIN_TYPEHASH,
                    _EIP712_NAME,
                    _EIP712_VERSION,
                    block.chainid,
                    address(this)
                )
            );
    }

    /// @dev Deduct `amountUSD` from the caller's spending limit. The beneficiary
    ///      can zero that limit in one transaction, which is the kill switch for a
    ///      compromised registrar, even when the price list quotes zero.
    function _spendAllowance(uint256 amountUSD) private {
        uint256 available = registrarAllowance[msg.sender];
        if (available == 0 || amountUSD > available)
            revert InsufficientAllowance(amountUSD, available);
        uint256 remaining;
        unchecked {
            remaining = available - amountUSD;
        }
        registrarAllowance[msg.sender] = remaining;
        emit RegistrarAllowanceSpent(msg.sender, amountUSD, remaining);
    }

    /// @dev Verify the owner's signature, then spend the nonce.
    function _consumeIntent(
        IETHRegistrarController.Registration calldata registration,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) private {
        if (block.timestamp > deadline) revert SignatureExpired();
        address owner = registration.owner;
        if (nonce != nonces[owner]) revert InvalidNonce();
        // EIP-712 encodes `bytes[]` as the hash of its elements' hashes.
        bytes32[] memory dataHashes = new bytes32[](registration.data.length);
        for (uint256 i = 0; i < dataHashes.length; ++i)
            dataHashes[i] = keccak256(registration.data[i]);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        REGISTER_TYPEHASH,
                        keccak256(bytes(registration.label)),
                        owner,
                        registration.resolver,
                        keccak256(abi.encodePacked(dataHashes)),
                        nonce,
                        deadline
                    )
                )
            )
        );
        if (!SignatureChecker.isValidSignatureNow(owner, digest, sig))
            revert InvalidSignature();
        unchecked {
            nonces[owner] = nonce + 1;
        }
    }
}
