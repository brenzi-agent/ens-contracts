//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

import {ENS} from "../registry/ENS.sol";
import {ISubnameRegistrar} from "./ISubnameRegistrar.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @dev The registrar-only record retirement on SimplexResolver. See
///      SimplexResolver.clearSubnameRecords for why `clearRecords` itself is
///      unreachable from here.
interface ISubnameRecordClearer {
    function clearSubnameRecords(bytes32 node) external;
}

/// @notice Creates, owns, and resolves subnames so they are *soulbound to the
///         2LD NFT*. A subname has no independent owner: in the registry it is
///         owned by this contract, and its effective owner is whoever holds the
///         parent 2LD token. Transferring the 2LD NFT moves every subname with
///         it instantly — no reclaim, no re-seize, no stale ownership.
///
///         It plugs into the verbatim PublicResolver's wrapper hook: deploy the
///         resolver with `nameWrapper = subnameRegistrar`, and the resolver
///         authorises a subname's records against `ownerOf(node)` below (the
///         live 2LD holder). The 2LD node itself is owned directly by the NFT
///         holder (BaseRegistrar auto-reclaim keeps it synced), so the 2LD is
///         NOT wrapped — only subname authorisation routes through here.
///
///         Re-registration of a 2LD bumps a per-2LD `generation`
///         (`onReregister`, called by BaseRegistrar), which invalidates the
///         previous owner's subnames; their leftover storage is reclaimed by the
///         permissionless `purge`. Depth is supported (subnames of subnames):
///         `ownerOf` walks up the parent chain to the 2LD.
contract SubnameRegistrar is ISubnameRegistrar {
    /// @dev The ENS registry.
    ENS public immutable ens;
    /// @dev BaseRegistrar; only it may bump generations.
    address public immutable baseRegistrar;
    /// @dev Resolver set on every created subname. One-time wiring (set after
    ///      the resolver is deployed, since the resolver's nameWrapper points
    ///      here), then immutable.
    address public resolver;
    address private immutable _deployer;

    /// @dev subname node => parent node (for the ownerOf walk-up).
    mapping(bytes32 => bytes32) public parentOf;
    /// @dev subname node => its parent's generation when it was created.
    mapping(bytes32 => uint256) public generationAt;
    /// @dev node => current generation (bumped on re-registration of a 2LD, and
    ///      on each creation of a subname this contract did not own).
    mapping(bytes32 => uint256) public generation;
    /// @dev 2LD node => registration expiry, mirrored from BaseRegistrar.
    ///      Registry ownership of a 2LD survives expiry — nothing clears it
    ///      until someone re-registers — so without this mirror a lapsed name's
    ///      former holder keeps full subname authority over the subtree, and
    ///      keeps it through the grace period and indefinitely beyond if nobody
    ///      re-registers. The registrar cannot derive it: it holds the node
    ///      hash, and `expiries` is keyed by the label hash it cannot invert.
    mapping(bytes32 => uint256) public expiryOf;

    /// @dev labelhash => plaintext label (write-once, shared across parents).
    mapping(bytes32 => string) public labelOf;
    /// @dev node => indexed (dedup).
    mapping(bytes32 => bool) public childIndexed;
    /// @dev parentNode => child labelhashes.
    mapping(bytes32 => bytes32[]) private _children;

    /// @dev Max subname label byte-length (the DNS octet limit), matching the
    ///      2LD cap. Constant — the contract has no general owner.
    uint256 public constant MAX_LABEL_LENGTH = 63;

    error NotParentOwner();
    error SignatureExpired();
    error InvalidNonce();
    error InvalidSignature();
    error LabelTooLong(uint256 length, uint256 max);
    error EmptyLabel();
    error NotBaseRegistrar();
    error AlreadyInitialised();
    error StaleSubnameMustBePurged(bytes32 node);

    event SubnameCreated(
        bytes32 indexed parentNode,
        bytes32 indexed node,
        bytes32 labelhash,
        string label
    );
    event SubnameDeleted(bytes32 indexed parentNode, bytes32 indexed node);
    event GenerationBumped(bytes32 indexed node, uint256 generation);

    /// SNRC: signed subname management, so a user with no ETH can create and
    /// delete subnames. Pairs with ENSRegistry.setApprovalForAllWithSig, which is
    /// how the same user grants this contract registry authority in the first
    /// place. Both are needed: one authorises the caller, the other the write.
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant _EIP712_NAME = keccak256("SimplexSubnames");
    bytes32 private constant _EIP712_VERSION = keccak256("1");
    bytes32 public constant CREATE_SUBNAME_TYPEHASH =
        keccak256(
            "CreateSubname(bytes32 parentNode,string label,uint256 nonce,uint256 deadline)"
        );
    bytes32 public constant DELETE_SUBNAME_TYPEHASH =
        keccak256(
            "DeleteSubname(bytes32 parentNode,string label,uint256 nonce,uint256 deadline)"
        );

    /// @dev One counter per signer, consumed in order.
    mapping(address => uint256) public nonces;

    constructor(ENS _ens, address _baseRegistrar) {
        ens = _ens;
        baseRegistrar = _baseRegistrar;
        _deployer = msg.sender;
    }

    /// @notice One-time wiring: set the resolver applied to created subnames.
    function setResolver(address _resolver) external {
        if (msg.sender != _deployer || resolver != address(0))
            revert AlreadyInitialised();
        resolver = _resolver;
    }

    // ---------- effective ownership (soulbound to the 2LD NFT) ----------

    /// @notice The effective owner of subname `node`: the holder of the parent
    ///         2LD NFT, found by walking up the parent chain to the 2LD node
    ///         (whose registry owner tracks the NFT via auto-reclaim). Returns
    ///         address(0) for an untracked node, a generation-dead subname, or
    ///         one whose chain up to the 2LD is broken (see `_intactRoot`).
    ///         This is the function the PublicResolver's wrapper hook calls to
    ///         authorise subname records.
    function ownerOf(uint256 node) public view returns (address) {
        bytes32 n = bytes32(node);
        if (parentOf[n] == bytes32(0)) return address(0);
        return _controller(n);
    }

    /// @dev Whether 2LD `root` is past its registration expiry. Matches the
    ///      registrar's own `ownerOf`, which reverts the moment a name expires
    ///      rather than at the end of the grace period; the grace period governs
    ///      re-registration, not continued authority.
    function _lapsed(bytes32 root) internal view returns (bool) {
        uint256 exp = expiryOf[root];
        return exp != 0 && block.timestamp > exp;
    }

    /// @dev The registered 2LD at the root of `node`'s parent chain if every
    ///      link is intact: each subname on the way up is owned by this contract
    ///      and was created under its parent's current generation. bytes32(0)
    ///      otherwise.
    function _intactRoot(bytes32 node) internal view returns (bytes32) {
        bytes32 n = node;
        while (parentOf[n] != bytes32(0)) {
            bytes32 p = parentOf[n];
            if (
                ens.owner(n) != address(this) || generationAt[n] != generation[p]
            ) return bytes32(0);
            n = p;
        }
        return expiryOf[n] == 0 ? bytes32(0) : n;
    }

    /// @dev Who may manage subnames under `node`: for a 2LD, its registry owner
    ///      (= NFT holder via auto-reclaim); for a subname (owned by this
    ///      contract), its effective NFT holder.
    function _controller(bytes32 node) internal view returns (address) {
        bytes32 root = _intactRoot(node);
        if (root == bytes32(0) || _lapsed(root)) return address(0);
        return ens.owner(root);
    }

    // ---------- create / delete ----------

    /// @notice Create `label`.<parent>, owned by this contract and soulbound to
    ///         the parent's 2LD NFT. The caller must be the effective owner of
    ///         `parentNode` and, for a 2LD parent, have approved this contract as
    ///         a registry operator (`ens.setApprovalForAll(subnameRegistrar,
    ///         true)`). Reverts on a subname this contract owns that was created
    ///         under an earlier generation of its parent; `purge` it first.
    function createSubname(
        bytes32 parentNode,
        string calldata label
    ) external returns (bytes32 node) {
        if (_controller(parentNode) != msg.sender) revert NotParentOwner();
        return _createSubname(parentNode, label);
    }

    /// @notice `createSubname` authorised by the parent owner's signature rather
    ///         than by the caller, so a relayer can pay the gas.
    function createSubnameWithSig(
        bytes32 parentNode,
        string calldata label,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external returns (bytes32 node) {
        _consumeIntent(
            CREATE_SUBNAME_TYPEHASH,
            parentNode,
            label,
            nonce,
            deadline,
            sig
        );
        return _createSubname(parentNode, label);
    }

    function _createSubname(
        bytes32 parentNode,
        string calldata label
    ) internal returns (bytes32 node) {
        // An empty label hashes to keccak256("") and namehashes back to the
        // parent, so `.alice.simplex` would be indexed as a child of itself.
        if (bytes(label).length == 0) revert EmptyLabel();
        if (bytes(label).length > MAX_LABEL_LENGTH)
            revert LabelTooLong(bytes(label).length, MAX_LABEL_LENGTH);
        bytes32 labelhash = keccak256(bytes(label));
        node = keccak256(abi.encodePacked(parentNode, labelhash));

        // Refuse to revive a subname left behind by a previous 2LD owner.
        // Reviving in place would re-point the registry record at the resolver
        // while that owner's records were still live under it, so the new holder
        // would silently inherit a name resolving to someone else's address.
        // `purge` retires the records and the index entry; creating afterwards
        // starts from nothing.
        bool owned = ens.owner(node) == address(this);
        if (
            owned &&
            parentOf[node] != bytes32(0) &&
            generationAt[node] != generation[parentNode]
        ) revert StaleSubnameMustBePurged(node);

        // Owned by this contract, with the resolver set so records resolve; the
        // PublicResolver then authorises those records against ownerOf(node).
        ens.setSubnodeRecord(parentNode, labelhash, address(this), resolver, 0);
        if (!owned) {
            if (resolver != address(0))
                ISubnameRecordClearer(resolver).clearSubnameRecords(node);
            ++generation[node];
        }

        parentOf[node] = parentNode;
        generationAt[node] = generation[parentNode];
        if (!childIndexed[node]) {
            childIndexed[node] = true;
            _children[parentNode].push(labelhash);
        }
        if (bytes(labelOf[labelhash]).length == 0) labelOf[labelhash] = label;
        emit SubnameCreated(parentNode, node, labelhash, label);
    }

    /// @notice Delete a subname (clears its record + index). Caller must be the
    ///         effective owner of the parent.
    function deleteSubname(bytes32 parentNode, string calldata label) external {
        if (_controller(parentNode) != msg.sender) revert NotParentOwner();
        _deleteSubname(parentNode, label);
    }

    /// @notice `deleteSubname` authorised by the parent owner's signature.
    function deleteSubnameWithSig(
        bytes32 parentNode,
        string calldata label,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external {
        _consumeIntent(
            DELETE_SUBNAME_TYPEHASH,
            parentNode,
            label,
            nonce,
            deadline,
            sig
        );
        _deleteSubname(parentNode, label);
    }

    function _deleteSubname(
        bytes32 parentNode,
        string calldata label
    ) internal {
        bytes32 labelhash = keccak256(bytes(label));
        bytes32 node = keccak256(abi.encodePacked(parentNode, labelhash));
        _clear(parentNode, node, labelhash);
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

    /// @dev Verify the parent owner's signature, then spend the nonce.
    function _consumeIntent(
        bytes32 typehash,
        bytes32 parentNode,
        string calldata label,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) internal {
        if (block.timestamp > deadline) revert SignatureExpired();
        address owner = _controller(parentNode);
        if (owner == address(0)) revert NotParentOwner();
        if (nonce != nonces[owner]) revert InvalidNonce();
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        typehash,
                        parentNode,
                        keccak256(bytes(label)),
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

    /// @notice Permissionless garbage collection: delete subnames whose chain up
    ///         to the 2LD is broken (as after the parent 2LD was re-registered),
    ///         reclaiming their registry + index storage. A lapsed 2LD's
    ///         subnames are kept, so a renewal restores them. Caller picks the
    ///         batch.
    function purge(
        bytes32 parentNode,
        bytes32[] calldata labelhashes
    ) external {
        for (uint256 i; i < labelhashes.length; i++) {
            bytes32 node = keccak256(
                abi.encodePacked(parentNode, labelhashes[i])
            );
            if (parentOf[node] == bytes32(0)) continue; // untracked
            if (_intactRoot(node) != bytes32(0)) continue;
            _clear(parentNode, node, labelhashes[i]);
        }
    }

    /// @dev Clear a subname this contract owns: zero its registry record (owner
    ///      + resolver) and drop its index entry. Authorised because this
    ///      contract owns the node.
    function _clear(
        bytes32 parentNode,
        bytes32 node,
        bytes32 labelhash
    ) internal {
        if (ens.owner(node) == address(this)) {
            // Retire the records before dropping the node. The node hash is
            // reused verbatim if the label is ever created again, so records
            // left behind here would resurface under the next owner.
            if (resolver != address(0))
                ISubnameRecordClearer(resolver).clearSubnameRecords(node);
            ens.setResolver(node, address(0));
            ens.setOwner(node, address(0));
        }
        delete parentOf[node];
        delete generationAt[node];
        if (childIndexed[node]) {
            childIndexed[node] = false;
            _removeChild(parentNode, labelhash);
        }
        emit SubnameDeleted(parentNode, node);
    }

    function _removeChild(bytes32 parentNode, bytes32 labelhash) internal {
        bytes32[] storage arr = _children[parentNode];
        uint256 len = arr.length;
        for (uint256 i; i < len; i++) {
            if (arr[i] == labelhash) {
                arr[i] = arr[len - 1];
                arr.pop();
                return;
            }
        }
    }

    // ---------- generation / GC hook ----------

    /// @notice Called by BaseRegistrar when 2LD `node` is re-registered:
    ///         invalidates the previous owner's subnames under it (O(1)). Their
    ///         storage is then reclaimable via `purge`.
    function onReregister(bytes32 node) external {
        if (msg.sender != baseRegistrar) revert NotBaseRegistrar();
        emit GenerationBumped(node, ++generation[node]);
    }

    /// @notice Called by BaseRegistrar whenever 2LD `node`'s expiry moves
    ///         (registration or renewal), so subname authority can follow the
    ///         registration rather than the registry record it outlives.
    function onExpiryChanged(bytes32 node, uint256 expiry) external {
        if (msg.sender != baseRegistrar) revert NotBaseRegistrar();
        expiryOf[node] = expiry;
    }

    // ---------- enumeration ----------

    /// @notice Number of indexed children of `parentNode` (including dead ones
    ///         not yet purged — filter on read via `ownerOf`).
    function childrenLength(
        bytes32 parentNode
    ) external view returns (uint256) {
        return _children[parentNode].length;
    }

    /// @notice Paginated children of `parentNode`: child labelhashes + plaintext
    ///         labels. A child is live iff `ownerOf(node) != address(0)`.
    function getChildren(
        bytes32 parentNode,
        uint256 start,
        uint256 count
    ) external view returns (bytes32[] memory hashes, string[] memory labels) {
        bytes32[] storage all = _children[parentNode];
        uint256 len = all.length;
        if (start >= len) return (new bytes32[](0), new string[](0));
        uint256 end = start + count;
        if (end > len) end = len;
        uint256 n = end - start;
        hashes = new bytes32[](n);
        labels = new string[](n);
        for (uint256 i; i < n; i++) {
            bytes32 labelhash = all[start + i];
            hashes[i] = labelhash;
            labels[i] = labelOf[labelhash];
        }
    }
}
