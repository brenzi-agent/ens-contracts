//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {BaseRegistrarImplementation} from "../ethregistrar/BaseRegistrarImplementation.sol";
import {ENS} from "../registry/ENS.sol";
import {INamePolicy} from "./INamePolicy.sol";
import {IClearableResolver, MAX_REGISTRATION, MAX_SPONSORED_REGISTRATION, MIN_REGISTRATION, SimplexController} from "./SimplexController.sol";

contract SimplexNamePolicy is INamePolicy, UUPSUpgradeable {
    SimplexController public immutable controller;
    BaseRegistrarImplementation public immutable registrar;
    ENS private immutable _ens;
    bytes32 private immutable _tldNode;
    address private immutable _self = address(this);

    /// @dev APPEND ONLY once names are reserved. The members are stored as their
    ///      positions, so reordering or removing one silently relabels every name
    ///      already reserved under it and nothing on chain can tell. `None` must
    ///      stay 0, because `delete` writes zero. The wording a user reads is
    ///      client-side.
    enum Reason {
        None,
        Internal,
        Trademark,
        Community
    }

    struct NameEntry {
        bool community;
        Reason reserved;
    }

    /// @dev Reason.None means not reserved, so this one mapping answers both
    ///      "is it reserved" and "why" - the two cannot drift apart.
    mapping(bytes32 => NameEntry) private _names;
    bytes32 public communityTermsHash;
    mapping(bytes32 => mapping(address => bytes32)) public acceptedTerms;
    mapping(uint256 => mapping(address => mapping(address => mapping(uint256 => bytes32))))
        public acceptedClaimTerms;
    mapping(address => uint256) public nonces;

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant _EIP712_NAME = keccak256("SimplexNamePolicy");
    bytes32 private constant _EIP712_VERSION = keccak256("1");
    bytes32 public constant ACCEPT_GENERAL_TERMS_TYPEHASH =
        keccak256(
            "AcceptGeneralTerms(bytes32 commitment,bytes32 termsHash,uint256 nonce,uint256 deadline)"
        );
    bytes32 public constant ACCEPT_GENERAL_TERMS_FOR_CLAIM_TYPEHASH =
        keccak256(
            "AcceptGeneralTermsForClaim(uint256 tokenId,address from,uint256 offer,bytes32 termsHash,uint256 nonce,uint256 deadline)"
        );
    bytes32 public constant ACCEPT_COMMUNITY_TERMS_TYPEHASH =
        keccak256(
            "AcceptCommunityTerms(bytes32 commitment,bytes32 termsHash,uint256 nonce,uint256 deadline)"
        );
    bytes32 public constant ACCEPT_COMMUNITY_TERMS_FOR_CLAIM_TYPEHASH =
        keccak256(
            "AcceptCommunityTermsForClaim(uint256 tokenId,address from,uint256 offer,bytes32 termsHash,uint256 nonce,uint256 deadline)"
        );

    event ReservedNameAdded(string name, Reason reason);
    event ReservedNameReasonChanged(string name, Reason reason);
    event ReservedNameRemoved(string name);
    event CommunityNameAdded(string name);
    event CommunityNameSkipped(string name);
    event CommunityNameRemoved(string name);
    event GeneralTermsSet(bytes32 termsHash, string link);
    event CommunityTermsSet(bytes32 termsHash, string link);
    event GeneralTermsAccepted(
        string name,
        address indexed holder,
        bytes32 termsHash
    );
    event CommunityTermsAccepted(
        string name,
        address indexed holder,
        bytes32 termsHash
    );

    error NotOwner();
    error NotOwnerOrBeneficiary();
    error NotController();
    error NotRegistrar();
    error ZeroTerms();
    error TermsMismatch(bytes32 accepted, bytes32 current);
    error TermsNotAccepted(string name);
    error SignatureExpired();
    error InvalidNonce();
    error InvalidSignature();
    error ReasonRequired();
    error NameNotReserved(string name);
    error NameReserved(string name);
    error DurationTooShort(uint256 duration);
    error DurationTooLong(uint256 duration);
    error Frozen();
    error ImplementationMismatch();
    error NotProxy();

    constructor(
        SimplexController _controller,
        BaseRegistrarImplementation _registrar
    ) {
        controller = _controller;
        registrar = _registrar;
        _ens = _controller.ens();
        _tldNode = _controller.tldNode();
    }

    modifier onlyOwner() {
        if (address(this) == _self) revert NotProxy();
        if (msg.sender != controller.owner()) revert NotOwner();
        _;
    }

    modifier onlyOwnerOrBeneficiary() {
        if (address(this) == _self) revert NotProxy();
        if (msg.sender != controller.owner() && msg.sender != controller.beneficiary())
            revert NotOwnerOrBeneficiary();
        _;
    }

    /// @notice Also stops the renewal of a registered name.
    /// @param reason `Reason.None` is refused: it is the value that means "not
    ///        reserved", so it would make this function silently unreserve.
    function addReservedNames(
        string[] calldata names,
        Reason reason
    ) external onlyOwnerOrBeneficiary {
        if (reason == Reason.None) revert ReasonRequired();
        for (uint256 i = 0; i < names.length; ++i) {
            _names[keccak256(bytes(names[i]))].reserved = reason;
            emit ReservedNameAdded(names[i], reason);
        }
    }

    /// @notice Reclassifies without unreserving: removing and re-adding would
    ///         open the name to a squatter for the gap between the two.
    function setReservationReason(
        string[] calldata names,
        Reason reason
    ) external onlyOwnerOrBeneficiary {
        if (reason == Reason.None) revert ReasonRequired();
        for (uint256 i = 0; i < names.length; ++i) {
            bytes32 labelhash = keccak256(bytes(names[i]));
            if (_names[labelhash].reserved == Reason.None)
                revert NameNotReserved(names[i]);
            _names[labelhash].reserved = reason;
            emit ReservedNameReasonChanged(names[i], reason);
        }
    }

    /// @notice Symmetric bulk-remove. Pass a single-element array to remove
    ///         one. Each removal emits a `ReservedNameRemoved` event.
    function removeReservedNames(string[] calldata names) external onlyOwner {
        for (uint256 i = 0; i < names.length; ++i) {
            delete _names[keccak256(bytes(names[i]))].reserved;
            emit ReservedNameRemoved(names[i]);
        }
    }

    /// @notice Hand a reserved name to its brand. Sets the default resolver on
    ///         the node, so the name resolves immediately
    ///         and the brand's later record edits can be relayed — a brand never
    ///         has to hold ETH. `setSubnodeOwner` alone sets an owner but not a
    ///         resolver, so without this the name would not resolve at all.
    ///         Releases the reservation, so the name renews like any other.
    function registerReserved(
        string calldata label,
        address owner,
        uint256 duration
    ) external onlyOwner {
        bytes32 labelhash = keccak256(bytes(label));
        if (_names[labelhash].reserved == Reason.None)
            revert NameNotReserved(label);
        if (duration < MIN_REGISTRATION)
            revert DurationTooShort(duration);
        if (duration > (_names[labelhash].community ? MAX_REGISTRATION : MAX_SPONSORED_REGISTRATION))
            revert DurationTooLong(duration);

        delete _names[labelhash].reserved;
        emit ReservedNameRemoved(label);

        bytes32 namehash = keccak256(abi.encodePacked(_tldNode, labelhash));
        registrar.registerWithLabel(label, address(this), duration);
        _retireStaleRecords(namehash);
        address resolver = controller.defaultResolver();
        if (resolver != address(0))
            _ens.setRecord(namehash, address(this), resolver, 0);
        registrar.transferFrom(address(this), owner, uint256(labelhash));
    }

    function reservedNames(bytes32 labelhash) external view returns (Reason) {
        return _names[labelhash].reserved;
    }

    function isReserved(bytes32 labelhash) external view returns (bool) {
        if (address(this) == _self) revert NotProxy();
        return _names[labelhash].reserved != Reason.None;
    }

    function communityNames(bytes32 labelhash) external view returns (bool) {
        return _names[labelhash].community;
    }

    function addCommunityNames(
        string[] calldata names
    ) external onlyOwnerOrBeneficiary {
        for (uint256 i = 0; i < names.length; ++i) {
            bytes32 labelhash = keccak256(bytes(names[i]));
            if (!registrar.available(uint256(labelhash))) {
                emit CommunityNameSkipped(names[i]);
                continue;
            }
            _names[labelhash].community = true;
            emit CommunityNameAdded(names[i]);
        }
    }

    function removeCommunityNames(string[] calldata names) external onlyOwner {
        for (uint256 i = 0; i < names.length; ++i) {
            delete _names[keccak256(bytes(names[i]))].community;
            emit CommunityNameRemoved(names[i]);
        }
    }

    function setGeneralTerms(
        string calldata link
    ) external onlyOwner {
        if (bytes(link).length == 0) revert ZeroTerms();
        generalTermsHash = keccak256(bytes(link));
        generalTermsLink = link;
        emit GeneralTermsSet(generalTermsHash, link);
    }

    function setCommunityTerms(
        string calldata link
    ) external onlyOwner {
        if (bytes(link).length == 0) revert ZeroTerms();
        communityTermsHash = keccak256(bytes(link));
        communityTermsLink = link;
        emit CommunityTermsSet(communityTermsHash, link);
    }

    function commitUnderGeneralTerms(
        bytes32 commitment,
        bytes32 acceptedTermsHash
    ) external {
        _acceptForCommitment(commitment, acceptedTermsHash, generalTermsHash, msg.sender);
    }

    function commitUnderGeneralTermsWithSig(
        bytes32 commitment,
        bytes32 acceptedTermsHash,
        address acceptor,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external {
        _consumeIntent(
            acceptor,
            keccak256(
                abi.encode(
                    ACCEPT_GENERAL_TERMS_TYPEHASH,
                    commitment,
                    acceptedTermsHash,
                    nonce,
                    deadline
                )
            ),
            nonce,
            deadline,
            sig
        );
        _acceptForCommitment(commitment, acceptedTermsHash, generalTermsHash, acceptor);
    }

    function commitUnderCommunityTerms(
        bytes32 commitment,
        bytes32 acceptedTermsHash
    ) external {
        _acceptForCommitment(commitment, acceptedTermsHash, communityTermsHash, msg.sender);
    }

    function commitUnderCommunityTermsWithSig(
        bytes32 commitment,
        bytes32 acceptedTermsHash,
        address acceptor,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external {
        _consumeIntent(
            acceptor,
            keccak256(
                abi.encode(
                    ACCEPT_COMMUNITY_TERMS_TYPEHASH,
                    commitment,
                    acceptedTermsHash,
                    nonce,
                    deadline
                )
            ),
            nonce,
            deadline,
            sig
        );
        _acceptForCommitment(commitment, acceptedTermsHash, communityTermsHash, acceptor);
    }

    function acceptGeneralTermsForClaim(
        uint256 tokenId,
        address from,
        uint256 offer,
        bytes32 acceptedTermsHash
    ) external {
        _acceptForClaim(tokenId, from, offer, acceptedTermsHash, generalTermsHash, msg.sender);
    }

    function acceptGeneralTermsForClaimWithSig(
        uint256 tokenId,
        address from,
        uint256 offer,
        bytes32 acceptedTermsHash,
        address recipient,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external {
        _consumeIntent(
            recipient,
            keccak256(
                abi.encode(
                    ACCEPT_GENERAL_TERMS_FOR_CLAIM_TYPEHASH,
                    tokenId,
                    from,
                    offer,
                    acceptedTermsHash,
                    nonce,
                    deadline
                )
            ),
            nonce,
            deadline,
            sig
        );
        _acceptForClaim(tokenId, from, offer, acceptedTermsHash, generalTermsHash, recipient);
    }

    function acceptCommunityTermsForClaim(
        uint256 tokenId,
        address from,
        uint256 offer,
        bytes32 acceptedTermsHash
    ) external {
        _acceptForClaim(tokenId, from, offer, acceptedTermsHash, communityTermsHash, msg.sender);
    }

    function acceptCommunityTermsForClaimWithSig(
        uint256 tokenId,
        address from,
        uint256 offer,
        bytes32 acceptedTermsHash,
        address recipient,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external {
        _consumeIntent(
            recipient,
            keccak256(
                abi.encode(
                    ACCEPT_COMMUNITY_TERMS_FOR_CLAIM_TYPEHASH,
                    tokenId,
                    from,
                    offer,
                    acceptedTermsHash,
                    nonce,
                    deadline
                )
            ),
            nonce,
            deadline,
            sig
        );
        _acceptForClaim(tokenId, from, offer, acceptedTermsHash, communityTermsHash, recipient);
    }

    function consumeRegistration(
        string calldata label,
        bytes32 labelhash,
        bytes32 commitment,
        address owner
    ) external {
        if (msg.sender != address(controller)) revert NotController();
        if (address(this) == _self) revert NotProxy();
        NameEntry memory entry = _names[labelhash];
        if (entry.reserved != Reason.None) revert NameReserved(label);
        bytes32 accepted = acceptedTerms[commitment][owner];
        delete acceptedTerms[commitment][owner];
        _confirmAcceptance(entry.community, accepted, label, owner);
    }

    function consumeTransfer(
        uint256 tokenId,
        address from,
        address to,
        uint256 offer,
        string calldata label
    ) external {
        if (msg.sender != address(registrar)) revert NotRegistrar();
        if (address(this) == _self) revert NotProxy();
        bytes32 accepted = acceptedClaimTerms[tokenId][from][to][offer];
        delete acceptedClaimTerms[tokenId][from][to][offer];
        _confirmAcceptance(_names[bytes32(tokenId)].community, accepted, label, to);
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

    function _retireStaleRecords(bytes32 node) private {
        address stale = _ens.resolver(node);
        if (stale != address(0) && controller.wasDefaultResolver(stale))
            IClearableResolver(stale).clearRecords(node);
    }

    function _acceptForCommitment(
        bytes32 commitment,
        bytes32 acceptedTermsHash,
        bytes32 currentTermsHash,
        address acceptor
    ) private {
        if (!_isCurrentTerms(acceptedTermsHash, currentTermsHash))
            revert TermsMismatch(acceptedTermsHash, currentTermsHash);
        acceptedTerms[commitment][acceptor] = acceptedTermsHash;
        bool unexpiredCommitmentExists = controller.commitments(commitment) +
            controller.maxCommitmentAge() >=
            block.timestamp;
        if (!unexpiredCommitmentExists) controller.commit(commitment);
    }

    function _acceptForClaim(
        uint256 tokenId,
        address from,
        uint256 offer,
        bytes32 acceptedTermsHash,
        bytes32 currentTermsHash,
        address recipient
    ) private {
        if (!_isCurrentTerms(acceptedTermsHash, currentTermsHash))
            revert TermsMismatch(acceptedTermsHash, currentTermsHash);
        acceptedClaimTerms[tokenId][from][recipient][offer] = acceptedTermsHash;
    }

    function _confirmAcceptance(
        bool community,
        bytes32 accepted,
        string calldata label,
        address holder
    ) private {
        if (community) {
            if (!_isCurrentTerms(accepted, communityTermsHash))
                revert TermsNotAccepted(label);
            emit CommunityTermsAccepted(label, holder, accepted);
        } else {
            if (!_isCurrentTerms(accepted, generalTermsHash))
                revert TermsNotAccepted(label);
            emit GeneralTermsAccepted(label, holder, accepted);
        }
    }

    function _isCurrentTerms(
        bytes32 hash,
        bytes32 currentTermsHash
    ) private pure returns (bool) {
        return hash != bytes32(0) && hash == currentTermsHash;
    }

    function _consumeIntent(
        address signer,
        bytes32 structHash,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) private {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (nonce != nonces[signer]) revert InvalidNonce();
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash)
        );
        if (!SignatureChecker.isValidSignatureNow(signer, digest, sig))
            revert InvalidSignature();
        unchecked {
            nonces[signer] = nonce + 1;
        }
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyOwner {
        if (controller.frozen()) revert Frozen();
        SimplexNamePolicy next = SimplexNamePolicy(newImplementation);
        if (next.controller() != controller || next.registrar() != registrar)
            revert ImplementationMismatch();
    }

    string public communityTermsLink;
    string public generalTermsLink;
    bytes32 public generalTermsHash;
    uint256[42] private __gap;
}
