//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {BaseRegistrarImplementation} from "../ethregistrar/BaseRegistrarImplementation.sol";
import {IETHRegistrarController, IPriceOracle} from "../ethregistrar/IETHRegistrarController.sol";
import {SimplexController} from "./SimplexController.sol";

/// @title SimplexSponsor
/// @notice The sponsored payment path. A registrar service registers and renews
///         names on its users' behalf against a spending limit the guardian
///         sets, and attaches no value; the controller does the registration.
///
/// Split out of `SimplexController` so the controller stays within the
/// contract size limit, and because this is the part that changes with the
/// service. It holds no key of its own: the guardian is the controller's
/// `beneficiary`, and the controller's owner can point the controller at a
/// replacement until `freeze`.
contract SimplexSponsor {
    // A name is registered only to an owner who agreed to hold it: the caller,
    // or an owner who signed `RegisterName`. The signature covers the label and
    // everything written at registration, so a relayer cannot attach records the
    // owner did not approve. It leaves out the secret, so an owner can sign
    // before the payer has chosen one, and the duration, since anyone may renew
    // anyone's name anyway. A deadline is enough against replay: once used, the
    // name stays unavailable for longer than any signature should live, and a
    // replay could only repeat what was signed.
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant _EIP712_NAME = keccak256("SimplexSponsor");
    bytes32 private constant _EIP712_VERSION = keccak256("1");
    bytes32 public constant REGISTER_TYPEHASH =
        keccak256(
            "RegisterName(string label,address owner,address resolver,bytes[] data,uint256 deadline)"
        );

    SimplexController public immutable controller;
    BaseRegistrarImplementation public immutable base;

    /// @dev Spending limit per registrar, in attoUSD. A sponsored registration or
    ///      renewal deducts the name's own list price. Denominated in the unit the
    ///      price list is configured in, so it does not move with the ETH price.
    mapping(address => uint256) public registrarAllowance;

    event RegistrarAllowanceSet(address indexed registrar, uint256 allowanceUSD);
    event RegistrarAllowanceSpent(
        address indexed registrar,
        uint256 spentUSD,
        uint256 remainingUSD
    );

    error NotBeneficiary();
    error InsufficientAllowance(uint256 required, uint256 available);
    error SignatureExpired();
    error InvalidSignature();

    constructor(SimplexController _controller, BaseRegistrarImplementation _base) {
        controller = _controller;
        base = _base;
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
    /// @param deadline Expiry of `sig`.
    /// @param sig The owner's EIP-712 `RegisterName` signature; not checked when
    ///        the owner is the caller.
    function registerWithCredit(
        IETHRegistrarController.Registration calldata registration,
        uint256 deadline,
        bytes calldata sig
    ) external {
        if (registration.owner != msg.sender) {
            if (block.timestamp > deadline) revert SignatureExpired();
            if (
                !SignatureChecker.isValidSignatureNow(
                    registration.owner,
                    _registerDigest(registration, deadline),
                    sig
                )
            ) revert InvalidSignature();
        }
        IPriceOracle.Price memory usd = _rentPriceUSD(
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
        _spendAllowance(_rentPriceUSD(label, duration).base);
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

    /// @dev The list price of `label` for `duration`, in attoUSD.
    function _rentPriceUSD(
        string calldata label,
        uint256 duration
    ) private view returns (IPriceOracle.Price memory) {
        return
            controller.prices().priceUSD(
                label,
                base.nameExpires(uint256(keccak256(bytes(label)))),
                duration
            );
    }

    /// @dev Deduct `amountUSD` from the caller's spending limit. The beneficiary
    ///      can zero that limit in one transaction, which is the kill switch for a
    ///      compromised registrar.
    function _spendAllowance(uint256 amountUSD) private {
        uint256 available = registrarAllowance[msg.sender];
        if (amountUSD > available)
            revert InsufficientAllowance(amountUSD, available);
        uint256 remaining;
        unchecked {
            remaining = available - amountUSD;
        }
        registrarAllowance[msg.sender] = remaining;
        emit RegistrarAllowanceSpent(msg.sender, amountUSD, remaining);
    }

    function _registerDigest(
        IETHRegistrarController.Registration calldata registration,
        uint256 deadline
    ) private view returns (bytes32) {
        // EIP-712 encodes `bytes[]` as the hash of its elements' hashes.
        bytes32[] memory dataHashes = new bytes32[](registration.data.length);
        for (uint256 i = 0; i < dataHashes.length; ++i)
            dataHashes[i] = keccak256(registration.data[i]);
        return
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    DOMAIN_SEPARATOR(),
                    keccak256(
                        abi.encode(
                            REGISTER_TYPEHASH,
                            keccak256(bytes(registration.label)),
                            registration.owner,
                            registration.resolver,
                            keccak256(abi.encodePacked(dataHashes)),
                            deadline
                        )
                    )
                )
            );
    }
}
