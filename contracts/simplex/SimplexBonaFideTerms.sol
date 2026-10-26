//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {BaseRegistrarImplementation} from "../ethregistrar/BaseRegistrarImplementation.sol";
import {IBonaFideTerms} from "./IBonaFideTerms.sol";
import {SimplexController} from "./SimplexController.sol";

contract SimplexBonaFideTerms is IBonaFideTerms {
    SimplexController public immutable controller;
    BaseRegistrarImplementation public immutable registrar;

    mapping(bytes32 => bool) public bonaFideNames;
    bytes32 public termsHash;
    mapping(bytes32 => mapping(address => bytes32)) public acceptedTerms;
    mapping(uint256 => mapping(address => mapping(address => mapping(uint256 => bytes32))))
        public acceptedClaimTerms;
    mapping(address => uint256) public nonces;

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant _EIP712_NAME = keccak256("SimplexBonaFideTerms");
    bytes32 private constant _EIP712_VERSION = keccak256("1");
    bytes32 public constant ACCEPT_TYPEHASH =
        keccak256(
            "AcceptBonaFideTerms(bytes32 commitment,bytes32 termsHash,uint256 nonce,uint256 deadline)"
        );
    bytes32 public constant ACCEPT_FOR_CLAIM_TYPEHASH =
        keccak256(
            "AcceptBonaFideTermsForClaim(uint256 tokenId,address from,uint256 offer,bytes32 termsHash,uint256 nonce,uint256 deadline)"
        );

    event BonaFideNameAdded(string name);
    event BonaFideNameSkipped(string name);
    event BonaFideNameRemoved(string name);
    event TermsSet(bytes32 termsHash, string termsURI);
    event BonaFideTermsAccepted(
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

    constructor(
        SimplexController _controller,
        BaseRegistrarImplementation _registrar
    ) {
        controller = _controller;
        registrar = _registrar;
    }

    modifier onlyOwner() {
        if (msg.sender != controller.owner()) revert NotOwner();
        _;
    }

    modifier onlyOwnerOrBeneficiary() {
        if (msg.sender != controller.owner() && msg.sender != controller.beneficiary())
            revert NotOwnerOrBeneficiary();
        _;
    }

    function addBonaFideNames(
        string[] calldata names
    ) external onlyOwnerOrBeneficiary {
        for (uint256 i = 0; i < names.length; ++i) {
            bytes32 labelhash = keccak256(bytes(names[i]));
            if (!registrar.available(uint256(labelhash))) {
                emit BonaFideNameSkipped(names[i]);
                continue;
            }
            bonaFideNames[labelhash] = true;
            emit BonaFideNameAdded(names[i]);
        }
    }

    function removeBonaFideNames(string[] calldata names) external onlyOwner {
        for (uint256 i = 0; i < names.length; ++i) {
            delete bonaFideNames[keccak256(bytes(names[i]))];
            emit BonaFideNameRemoved(names[i]);
        }
    }

    function setTerms(
        bytes32 newTermsHash,
        string calldata termsURI
    ) external onlyOwner {
        if (newTermsHash == bytes32(0)) revert ZeroTerms();
        termsHash = newTermsHash;
        emit TermsSet(newTermsHash, termsURI);
    }

    function commitUnderBonaFideCommunityTerms(
        bytes32 commitment,
        bytes32 acceptedTermsHash
    ) external {
        _acceptForCommitment(commitment, acceptedTermsHash, msg.sender);
    }

    function commitUnderBonaFideCommunityTermsWithSig(
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
                    ACCEPT_TYPEHASH,
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
        _acceptForCommitment(commitment, acceptedTermsHash, acceptor);
    }

    function acceptBonaFideCommunityTermsForClaim(
        uint256 tokenId,
        address from,
        uint256 offer,
        bytes32 acceptedTermsHash
    ) external {
        _acceptForClaim(tokenId, from, offer, acceptedTermsHash, msg.sender);
    }

    function acceptBonaFideCommunityTermsForClaimWithSig(
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
                    ACCEPT_FOR_CLAIM_TYPEHASH,
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
        _acceptForClaim(tokenId, from, offer, acceptedTermsHash, recipient);
    }

    function consumeRegistration(
        string calldata label,
        bytes32 labelhash,
        bytes32 commitment,
        address owner
    ) external {
        if (msg.sender != address(controller)) revert NotController();
        if (!bonaFideNames[labelhash]) return;
        bytes32 accepted = acceptedTerms[commitment][owner];
        if (!_isCurrentTerms(accepted)) revert TermsNotAccepted(label);
        delete acceptedTerms[commitment][owner];
        emit BonaFideTermsAccepted(label, owner, accepted);
    }

    function consumeTransfer(
        uint256 tokenId,
        address from,
        address to,
        uint256 offer,
        string calldata label
    ) external {
        if (msg.sender != address(registrar)) revert NotRegistrar();
        if (!bonaFideNames[bytes32(tokenId)]) return;
        bytes32 accepted = acceptedClaimTerms[tokenId][from][to][offer];
        if (!_isCurrentTerms(accepted)) revert TermsNotAccepted(label);
        delete acceptedClaimTerms[tokenId][from][to][offer];
        emit BonaFideTermsAccepted(label, to, accepted);
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

    function _acceptForCommitment(
        bytes32 commitment,
        bytes32 acceptedTermsHash,
        address acceptor
    ) private {
        if (!_isCurrentTerms(acceptedTermsHash))
            revert TermsMismatch(acceptedTermsHash, termsHash);
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
        address recipient
    ) private {
        if (!_isCurrentTerms(acceptedTermsHash))
            revert TermsMismatch(acceptedTermsHash, termsHash);
        acceptedClaimTerms[tokenId][from][recipient][offer] = acceptedTermsHash;
    }

    function _isCurrentTerms(bytes32 hash) private view returns (bool) {
        return hash != bytes32(0) && hash == termsHash;
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
}
