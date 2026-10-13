pragma solidity >=0.8.4;

import "./ENS.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// The ENS registry contract.
contract ENSRegistry is ENS {
    struct Record {
        address owner;
        address resolver;
        uint64 ttl;
    }

    mapping(bytes32 => Record) records;
    mapping(address => mapping(address => bool)) operators;

    /// SNRC: signed operator approval. A user with no ETH cannot call
    /// `setApprovalForAll`, and it is the one call the sponsored design cannot
    /// relay any other way — the registry is the authority and has no other hook.
    /// The state written is exactly what `setApprovalForAll` writes; the only new
    /// capability is signing instead of paying gas.
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant _EIP712_NAME = keccak256("SimplexENSRegistry");
    bytes32 private constant _EIP712_VERSION = keccak256("1");
    bytes32 public constant APPROVE_ALL_TYPEHASH =
        keccak256(
            "ApproveAll(address owner,address operator,bool approved,uint256 nonce,uint256 deadline)"
        );

    /// @dev One counter per approver, so a signature cannot be replayed and two
    ///      approvals cannot be reordered.
    mapping(address => uint256) public nonces;

    /// SNRC: a node's new owner must be the caller or zero, except for the root
    /// node and for subnodes of the root or of a TLD, which the root's owner and
    /// the TLD's owner assign. `setSubnodeOwner` records a node as a TLD when
    /// its parent is the root.
    mapping(bytes32 => bool) public isTld;

    error SignatureExpired();
    error InvalidNonce();
    error InvalidSignature();
    error OwnerMustBeCaller();

    // Permits modifications only by the owner of the specified node.
    modifier authorised(bytes32 node) {
        address owner = records[node].owner;
        require(owner == msg.sender || operators[owner][msg.sender]);
        _;
    }

    /// @dev Constructs a new ENS registry.
    constructor() public {
        records[0x0].owner = msg.sender;
    }

    /// @dev Sets the record for a node.
    /// @param node The node to update.
    /// @param owner The address of the new owner.
    /// @param resolver The address of the resolver.
    /// @param ttl The TTL in seconds.
    function setRecord(
        bytes32 node,
        address owner,
        address resolver,
        uint64 ttl
    ) external virtual override {
        setOwner(node, owner);
        _setResolverAndTTL(node, resolver, ttl);
    }

    /// @dev Sets the record for a subnode.
    /// @param node The parent node.
    /// @param label The hash of the label specifying the subnode.
    /// @param owner The address of the new owner.
    /// @param resolver The address of the resolver.
    /// @param ttl The TTL in seconds.
    function setSubnodeRecord(
        bytes32 node,
        bytes32 label,
        address owner,
        address resolver,
        uint64 ttl
    ) external virtual override {
        bytes32 subnode = setSubnodeOwner(node, label, owner);
        _setResolverAndTTL(subnode, resolver, ttl);
    }

    /// @dev Transfers ownership of a node to a new address. May only be called by the current owner of the node.
    /// @param node The node to transfer ownership of.
    /// @param owner The address of the new owner.
    function setOwner(
        bytes32 node,
        address owner
    ) public virtual override authorised(node) {
        if (owner != msg.sender && owner != address(0) && node != bytes32(0))
            revert OwnerMustBeCaller();
        _setOwner(node, owner);
        emit Transfer(node, owner);
    }

    /// @dev Transfers ownership of a subnode keccak256(node, label) to a new address. May only be called by the owner of the parent node.
    /// @param node The parent node.
    /// @param label The hash of the label specifying the subnode.
    /// @param owner The address of the new owner.
    function setSubnodeOwner(
        bytes32 node,
        bytes32 label,
        address owner
    ) public virtual override authorised(node) returns (bytes32) {
        bytes32 subnode = keccak256(abi.encodePacked(node, label));
        if (node == bytes32(0)) isTld[subnode] = true;
        else if (owner != msg.sender && owner != address(0) && !isTld[node])
            revert OwnerMustBeCaller();
        _setOwner(subnode, owner);
        emit NewOwner(node, label, owner);
        return subnode;
    }

    /// @dev Sets the resolver address for the specified node.
    /// @param node The node to update.
    /// @param resolver The address of the resolver.
    function setResolver(
        bytes32 node,
        address resolver
    ) public virtual override authorised(node) {
        emit NewResolver(node, resolver);
        records[node].resolver = resolver;
    }

    /// @dev Sets the TTL for the specified node.
    /// @param node The node to update.
    /// @param ttl The TTL in seconds.
    function setTTL(
        bytes32 node,
        uint64 ttl
    ) public virtual override authorised(node) {
        emit NewTTL(node, ttl);
        records[node].ttl = ttl;
    }

    /// @dev Enable or disable approval for a third party ("operator") to manage
    ///      all of `msg.sender`'s ENS records. Emits the ApprovalForAll event.
    /// @param operator Address to add to the set of authorized operators.
    /// @param approved True if the operator is approved, false to revoke approval.
    function setApprovalForAll(
        address operator,
        bool approved
    ) external virtual override {
        operators[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
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

    /// @dev `setApprovalForAll` on behalf of `approvalOwner`, who signed rather
    ///      than paid. The caller supplies gas and nothing else: it cannot choose
    ///      the operator, cannot replay, and cannot act after the deadline.
    /// @param approvalOwner The address granting or revoking the approval.
    /// @param operator Address to add to or remove from the set of operators.
    /// @param approved True to approve, false to revoke.
    /// @param nonce Must equal `nonces(approvalOwner)`.
    /// @param deadline Unix time after which the signature is refused.
    /// @param sig EIP-712 signature over `APPROVE_ALL_TYPEHASH`.
    function setApprovalForAllWithSig(
        address approvalOwner,
        address operator,
        bool approved,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external virtual {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (nonce != nonces[approvalOwner]) revert InvalidNonce();
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        APPROVE_ALL_TYPEHASH,
                        approvalOwner,
                        operator,
                        approved,
                        nonce,
                        deadline
                    )
                )
            )
        );
        if (!SignatureChecker.isValidSignatureNow(approvalOwner, digest, sig))
            revert InvalidSignature();
        unchecked {
            nonces[approvalOwner] = nonce + 1;
        }
        operators[approvalOwner][operator] = approved;
        emit ApprovalForAll(approvalOwner, operator, approved);
    }

    /// @dev Returns the address that owns the specified node.
    /// @param node The specified node.
    /// @return address of the owner.
    function owner(
        bytes32 node
    ) public view virtual override returns (address) {
        address addr = records[node].owner;
        if (addr == address(this)) {
            return address(0x0);
        }

        return addr;
    }

    /// @dev Returns the address of the resolver for the specified node.
    /// @param node The specified node.
    /// @return address of the resolver.
    function resolver(
        bytes32 node
    ) public view virtual override returns (address) {
        return records[node].resolver;
    }

    /// @dev Returns the TTL of a node, and any records associated with it.
    /// @param node The specified node.
    /// @return ttl of the node.
    function ttl(bytes32 node) public view virtual override returns (uint64) {
        return records[node].ttl;
    }

    /// @dev Returns whether a record has been imported to the registry.
    /// @param node The specified node.
    /// @return Bool if record exists
    function recordExists(
        bytes32 node
    ) public view virtual override returns (bool) {
        return records[node].owner != address(0x0);
    }

    /// @dev Query if an address is an authorized operator for another address.
    /// @param owner The address that owns the records.
    /// @param operator The address that acts on behalf of the owner.
    /// @return True if `operator` is an approved operator for `owner`, false otherwise.
    function isApprovedForAll(
        address owner,
        address operator
    ) external view virtual override returns (bool) {
        return operators[owner][operator];
    }

    function _setOwner(bytes32 node, address owner) internal virtual {
        records[node].owner = owner;
    }

    function _setResolverAndTTL(
        bytes32 node,
        address resolver,
        uint64 ttl
    ) internal {
        if (resolver != records[node].resolver) {
            records[node].resolver = resolver;
            emit NewResolver(node, resolver);
        }

        if (ttl != records[node].ttl) {
            records[node].ttl = ttl;
            emit NewTTL(node, ttl);
        }
    }
}
