//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {BaseRegistrarImplementation} from "../ethregistrar/BaseRegistrarImplementation.sol";
import {ISettlement} from "./INamePolicy.sol";
import {SimplexController} from "./SimplexController.sol";

contract SimplexSettlement is ISettlement, UUPSUpgradeable {
    uint256 public constant MAX_REVERSIBLE_DAYS = 180;
    uint256 public constant SETTLEMENT_WINDOW = 30 days;
    uint256 private constant _GRACE_PERIOD = 90 days;

    SimplexController public immutable controller;
    BaseRegistrarImplementation public immutable registrar;
    address private immutable _self = address(this);

    struct Entry {
        uint64 reversibleUntil;
        uint64 firstExpiry;
        uint64 remaining;
        bool reversed;
        bool renewal;
    }

    mapping(uint256 => Entry) private _entries;

    event NamePaymentReversible(
        bytes32 indexed labelhash,
        uint256 reversibleUntil,
        uint256 paidExpires,
        bool renewal
    );
    event NamePaymentReversed(bytes32 indexed labelhash);
    event NamePaymentReversalSkipped(string label);
    event NamePaymentReinstatementSkipped(string label);
    event NamePaymentSettled(bytes32 indexed labelhash, uint256 expires);

    error ReversibleDaysTooMany(uint256 reversibleDays);
    error DurationTooShort(uint256 duration);
    error NotController();
    error NotProxy();
    error NotOwner();
    error NotOwnerOrBeneficiary();
    error Frozen();
    error ImplementationMismatch();
    error NotReversible(string label);
    error ReversiblePeriodNotEnded(string label);
    error PaymentReversed(string label);
    error RenewalReversed(bytes32 labelhash);

    constructor(
        SimplexController _controller,
        BaseRegistrarImplementation _registrar
    ) {
        controller = _controller;
        registrar = _registrar;
    }

    function open(
        uint256 id,
        uint256 reversibleDays,
        uint256 duration,
        bool renewal
    ) external returns (uint256 extension) {
        if (msg.sender != address(controller)) revert NotController();
        if (address(this) == _self) revert NotProxy();
        if (reversibleDays > MAX_REVERSIBLE_DAYS)
            revert ReversibleDaysTooMany(reversibleDays);
        Entry memory current = _entries[id];
        if (current.reversed && _inEffect(id, current))
            revert RenewalReversed(bytes32(id));
        uint256 start = renewal ? registrar.nameExpires(id) : block.timestamp;
        uint256 reversibleUntil = block.timestamp + reversibleDays * 1 days;
        uint256 firstExpiry = reversibleUntil + SETTLEMENT_WINDOW;
        if (firstExpiry < start) firstExpiry = start;
        extension = firstExpiry - start;
        if (duration <= extension) revert DurationTooShort(duration);
        _entries[id] = Entry(
            uint64(reversibleUntil),
            uint64(firstExpiry),
            uint64(duration - extension),
            false,
            renewal
        );
        emit NamePaymentReversible(
            bytes32(id),
            reversibleUntil,
            start + duration,
            renewal
        );
    }

    function settle(string calldata label) external {
        uint256 id = uint256(keccak256(bytes(label)));
        Entry memory entry = _entries[id];
        if (!_inEffect(id, entry)) revert NotReversible(label);
        if (entry.reversed) revert PaymentReversed(label);
        if (block.timestamp < entry.reversibleUntil)
            revert ReversiblePeriodNotEnded(label);
        _settle(id, entry.remaining);
    }

    function reversePayments(string[] calldata labels) external {
        if (address(this) == _self) revert NotProxy();
        if (
            msg.sender != controller.beneficiary() &&
            msg.sender != controller.owner()
        ) revert NotOwnerOrBeneficiary();
        for (uint256 i = 0; i < labels.length; ++i) {
            uint256 id = uint256(keccak256(bytes(labels[i])));
            Entry memory entry = _entries[id];
            if (
                !_inEffect(id, entry) ||
                entry.reversed ||
                block.timestamp >= entry.reversibleUntil
            ) {
                emit NamePaymentReversalSkipped(labels[i]);
                continue;
            }
            _entries[id].reversed = true;
            emit NamePaymentReversed(bytes32(id));
        }
    }

    function reinstatePayments(string[] calldata labels) external {
        if (address(this) == _self) revert NotProxy();
        if (msg.sender != controller.owner()) revert NotOwner();
        for (uint256 i = 0; i < labels.length; ++i) {
            uint256 id = uint256(keccak256(bytes(labels[i])));
            Entry memory entry = _entries[id];
            if (!_inEffect(id, entry) || !entry.reversed) {
                emit NamePaymentReinstatementSkipped(labels[i]);
                continue;
            }
            _settle(id, entry.remaining);
        }
    }

    function reversiblePayment(
        uint256 id
    )
        external
        view
        returns (
            uint256 reversibleUntil,
            uint256 paidExpires,
            bool reversed,
            bool renewal
        )
    {
        if (address(this) == _self) revert NotProxy();
        Entry memory entry = _entries[id];
        if (_inEffect(id, entry) && !(entry.renewal && entry.reversed))
            return (
                entry.reversibleUntil,
                entry.firstExpiry + entry.remaining,
                entry.reversed,
                entry.renewal
            );
    }

    function _settle(uint256 id, uint256 remaining) private {
        delete _entries[id];
        emit NamePaymentSettled(bytes32(id), registrar.renew(id, remaining));
    }

    function _inEffect(
        uint256 id,
        Entry memory entry
    ) private view returns (bool) {
        return
            block.timestamp <= entry.firstExpiry + _GRACE_PERIOD &&
            registrar.nameExpires(id) == entry.firstExpiry;
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        if (msg.sender != controller.owner()) revert NotOwner();
        if (controller.frozen()) revert Frozen();
        SimplexSettlement next = SimplexSettlement(newImplementation);
        if (next.controller() != controller || next.registrar() != registrar)
            revert ImplementationMismatch();
    }

    uint256[49] private __gap;
}
