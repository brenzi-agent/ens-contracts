pragma solidity >=0.8.4;

import "../registry/ENS.sol";
import "../simplex/IBonaFideTerms.sol";
import "./IBaseRegistrar.sol";
import "./IMetadataRenderer.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @dev Notified when a 2LD is re-registered, so subname ownership/generation
///      state (kept by the SubnameRegistrar) can be invalidated. See
///      contracts/simplex/SubnameRegistrar.sol.
interface ISubnameHook {
    function onReregister(bytes32 node) external;

    function onExpiryChanged(bytes32 node, uint256 expiry) external;
}

/// @dev INVARIANT (ERC721Enumerable): enumeration (`totalSupply`,
///      `tokenByIndex`, `balanceOf`, `tokenOfOwnerByIndex`) is maintained on
///      transfer/mint/burn, NOT on expiry — a name is only burned when it is
///      re-registered after its grace period. So enumeration includes
///      expired-but-unburned names and can disagree with the grace-period
///      `ownerOf` (which reverts once expired). Readers MUST filter by
///      `nameExpires(id) > block.timestamp` to get the live set.
contract BaseRegistrarImplementation is
    ERC721Enumerable,
    IBaseRegistrar,
    Ownable
{
    // A map of expiry times
    mapping(uint256 => uint256) expiries;
    // labelhash (tokenId) => plaintext label, recorded write-once by registerWithLabel.
    mapping(uint256 => string) public labelOf;
    // Swappable on-chain metadata renderer; tokenURI delegates here.
    address public metadataRenderer;
    // Max label byte-length accepted by registerWithLabel; 0 = no limit. Set at
    // deployment (and adjustable by the owner) as a per-TLD policy knob.
    uint256 public maxLabelLength;
    // SubnameRegistrar, notified on re-registration so the previous owner's
    // subnames are invalidated/garbage-collectable. Optional (0 = disabled).
    address public subnameHook;
    address public bonaFideHook;
    // The ENS registry
    ENS public ens;
    // The namehash of the TLD this registrar owns (eg, .eth)
    bytes32 public baseNode;
    // A map of addresses that are authorised to register and renew names.
    mapping(address => bool) public controllers;
    uint256 public constant GRACE_PERIOD = 90 days;
    bytes4 private constant INTERFACE_META_ID =
        bytes4(keccak256("supportsInterface(bytes4)"));
    bytes4 private constant RECLAIM_ID =
        bytes4(keccak256("reclaim(uint256,address)"));

    event MetadataRendererChanged(address indexed renderer);
    event MaxLabelLengthChanged(uint256 maxLabelLength);
    event SubnameHookChanged(address indexed hook);
    event BonaFideHookChanged(address indexed hook);

    error LabelTooLong(uint256 length, uint256 max);
    error BonaFideHookMismatch();

    /// v2.1.3 version of _isApprovedOrOwner which calls ownerOf(tokenId) and takes grace period into consideration instead of ERC721.ownerOf(tokenId);
    /// https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v2.1.3/contracts/token/ERC721/ERC721.sol#L187
    /// @dev Returns whether the given spender can transfer a given token ID
    /// @param spender address of the spender to query
    /// @param tokenId uint256 ID of the token to be transferred
    /// @return bool whether the msg.sender is approved for the given token ID,
    ///              is an operator of the owner, or is the owner of the token
    function _isApprovedOrOwner(
        address spender,
        uint256 tokenId
    ) internal view override returns (bool) {
        address owner = ownerOf(tokenId);
        return (spender == owner ||
            getApproved(tokenId) == spender ||
            isApprovedForAll(owner, spender));
    }

    constructor(
        ENS _ens,
        bytes32 _baseNode
    ) ERC721("SimpleX Names", "SIMPLEX") {
        ens = _ens;
        baseNode = _baseNode;
    }

    modifier live() {
        require(ens.owner(baseNode) == address(this));
        _;
    }

    modifier onlyController() {
        require(controllers[msg.sender]);
        _;
    }

    /// @dev Gets the owner of the specified token ID. Names become unowned
    ///      when their registration expires.
    /// @param tokenId uint256 ID of the token to query the owner of
    /// @return address currently marked as the owner of the given token ID
    function ownerOf(
        uint256 tokenId
    ) public view override(IERC721, ERC721) returns (address) {
        require(expiries[tokenId] > block.timestamp);
        return super.ownerOf(tokenId);
    }

    // Authorises a controller, who can register and renew domains.
    function addController(address controller) external override onlyOwner {
        controllers[controller] = true;
        emit ControllerAdded(controller);
    }

    // Revoke controller permission for an address.
    function removeController(address controller) external override onlyOwner {
        controllers[controller] = false;
        emit ControllerRemoved(controller);
    }

    // Set the resolver for the TLD this registrar manages.
    function setResolver(address resolver) external override onlyOwner {
        ens.setResolver(baseNode, resolver);
    }

    // Returns the expiration timestamp of the specified id.
    function nameExpires(uint256 id) external view override returns (uint256) {
        return expiries[id];
    }

    // Returns true iff the specified name is available for registration.
    function available(uint256 id) public view override returns (bool) {
        // Not available if it's registered here or in its grace period.
        return expiries[id] + GRACE_PERIOD < block.timestamp;
    }

    /// @dev Register a name from its plaintext label, recording the label
    ///      on-chain (write-once) so hash->name resolves without an indexer.
    ///      This is the only registration path: there is no raw-labelhash
    ///      register, so every registration records its label.
    /// @param label The plaintext label (eg "alice").
    /// @param owner The address that should own the registration.
    /// @param duration Duration in seconds for the registration.
    function registerWithLabel(
        string calldata label,
        address owner,
        uint256 duration
    ) external returns (uint256) {
        if (maxLabelLength != 0 && bytes(label).length > maxLabelLength)
            revert LabelTooLong(bytes(label).length, maxLabelLength);
        uint256 id = uint256(keccak256(bytes(label)));
        if (bytes(labelOf[id]).length == 0) {
            labelOf[id] = label;
        }
        return _register(id, owner, duration);
    }

    function _register(
        uint256 id,
        address owner,
        uint256 duration
    ) internal live onlyController returns (uint256) {
        require(available(id));
        require(
            block.timestamp + duration + GRACE_PERIOD >
                block.timestamp + GRACE_PERIOD
        ); // Prevent future overflow

        expiries[id] = block.timestamp + duration;
        if (_exists(id)) {
            // Name was previously owned and expired. Burn it, and bump the
            // subname generation so the previous registrant's subnames are
            // invalidated (not inherited by the new owner) and become
            // garbage-collectable. See SubnameRegistrar.onReregister.
            //
            // NOTE for hook authors: this fires between the burn and the mint.
            // The token does not exist at this instant — `ownerOf` reverts and
            // `ens.owner` still names the previous holder — so a hook must not
            // read either. `onExpiryChanged` below fires after the mint, when
            // both are settled.
            _burn(id);
            if (subnameHook != address(0)) {
                ISubnameHook(subnameHook).onReregister(
                    keccak256(abi.encodePacked(baseNode, bytes32(id)))
                );
            }
        }
        _mint(owner, id);
        ens.setSubnodeOwner(baseNode, bytes32(id), owner);
        if (subnameHook != address(0)) {
            ISubnameHook(subnameHook).onExpiryChanged(
                keccak256(abi.encodePacked(baseNode, bytes32(id))),
                expiries[id]
            );
        }

        emit NameRegistered(id, owner, block.timestamp + duration);

        return block.timestamp + duration;
    }

    function renew(
        uint256 id,
        uint256 duration
    ) external override live onlyController returns (uint256) {
        require(expiries[id] + GRACE_PERIOD >= block.timestamp); // Name must be registered here or in grace period
        require(
            expiries[id] + duration + GRACE_PERIOD > duration + GRACE_PERIOD
        ); // Prevent future overflow

        expiries[id] += duration;
        if (subnameHook != address(0)) {
            ISubnameHook(subnameHook).onExpiryChanged(
                keccak256(abi.encodePacked(baseNode, bytes32(id))),
                expiries[id]
            );
        }
        emit NameRenewed(id, expiries[id]);
        return expiries[id];
    }

    /// @dev Reclaim ownership of a name in ENS, if you own it in the registrar.
    function reclaim(uint256 id, address owner) external override live {
        require(_isApprovedOrOwner(msg.sender, id));
        require(owner == ownerOf(id));
        ens.setSubnodeOwner(baseNode, bytes32(id), owner);
    }

    // Sets the on-chain metadata renderer that tokenURI delegates to.
    function setMetadataRenderer(address renderer) external onlyOwner {
        metadataRenderer = renderer;
        emit MetadataRendererChanged(renderer);
    }

    // Sets the max label byte-length for registerWithLabel; 0 = no limit.
    function setMaxLabelLength(uint256 newMax) external onlyOwner {
        maxLabelLength = newMax;
        emit MaxLabelLengthChanged(newMax);
    }

    // Sets the SubnameRegistrar notified on re-registration; 0 disables.
    function setSubnameHook(address hook) external onlyOwner {
        subnameHook = hook;
        emit SubnameHookChanged(hook);
    }

    function setBonaFideHook(address hook) external onlyOwner {
        if (
            hook != address(0) &&
            IBonaFideTermsBinding(hook).registrar() != address(this)
        ) revert BonaFideHookMismatch();
        bonaFideHook = hook;
        emit BonaFideHookChanged(hook);
    }

    /// ------------------------------------------------------------------
    /// Consented transfer
    ///
    /// A transfer completes only when the recipient is the caller, so nobody
    /// becomes the holder of a name without their consent: the holder offers
    /// it with `approve`, and the recipient calls `transferFrom`. A controller
    /// may call `transferFrom` for anyone, so a new registration can be
    /// transferred from the controller to its owner.
    ///
    /// Either half can be signed instead (EIP-712) and submitted by a relayer,
    /// so neither party needs ETH. The relayer pays gas and nothing
    /// else: it cannot choose the recipient, cannot replay, and cannot act
    /// after the deadline.
    /// ------------------------------------------------------------------

    function transferFrom(
        address from,
        address to,
        uint256 tokenId
    ) public override(IERC721, ERC721) {
        if (to != msg.sender && !controllers[msg.sender])
            revert RecipientMustBeCaller();
        super.transferFrom(from, to, tokenId);
    }

    /// @dev The three-argument overload delegates here.
    function safeTransferFrom(
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) public override(IERC721, ERC721) {
        if (to != msg.sender) revert RecipientMustBeCaller();
        super.safeTransferFrom(from, to, tokenId, data);
    }

    function _approve(address to, uint256 tokenId) internal override {
        super._approve(to, tokenId);
        unchecked {
            ++offers[tokenId];
        }
    }

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant _EIP712_NAME = keccak256("SimplexNames");
    bytes32 private constant _EIP712_VERSION = keccak256("1");
    bytes32 public constant APPROVE_TYPEHASH =
        keccak256(
            "ApproveName(address from,address to,uint256 tokenId,bytes ephemeralPubKey,bytes1 viewTag,uint256 nonce,uint256 deadline)"
        );
    bytes32 public constant CLAIM_TYPEHASH =
        keccak256(
            "ClaimName(address from,address to,uint256 tokenId,uint256 offer,uint256 nonce,uint256 deadline)"
        );

    /// @dev ERC-5564 scheme id 1: secp256k1 with view tags, the only scheme the
    ///      standard currently registers and the one the client implements.
    uint256 public constant STEALTH_SCHEME_ID = 1;

    /// @dev One counter per signer, consumed in order, so a signature cannot be
    ///      replayed and two intents cannot be reordered.
    mapping(address => uint256) public nonces;

    /// @dev The number of the current offer for each token, incremented by every
    ///      `approve`, so a claim signature is valid for one offer and no later one.
    mapping(uint256 => uint256) public offers;

    /// @dev ERC-5564 `Announcement`, verbatim in name, parameter list and
    ///      indexing, so any indexer that knows the standard decodes ours by
    ///      topic without special-casing. It carries the sender's ephemeral
    ///      public key so the recipient can rediscover a stealth destination
    ///      from their seed alone — without it a gift is findable only from a
    ///      message, and a restored device has no messages. Emitted with the
    ///      offer, so an offer not yet claimed is findable too, and only when
    ///      the sender opts in, so an ordinary offer costs nothing extra.
    ///
    ///      Deliberately emitted by this contract rather than through the
    ///      canonical singleton announcer: a recovery scan then covers SimpleX
    ///      name transfers only, instead of every stealth transfer on the chain.
    ///      That is the whole reason the scan is cheap enough to run on restore.
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    error TransferToSelf();
    error SignatureExpired();
    error InvalidNonce();
    error InvalidSignature();
    error NotNameOwner();
    error RecipientMustBeCaller();
    error NotOffered();

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

    /// @notice Offer `tokenId` to `to`, signed by the holder `from`: the
    ///         `approve` half. `to = address(0)` withdraws the offer. The name
    ///         stays with `from` until `to` claims it.
    /// @param ephemeralPubKey Compressed secp256k1 point, or empty for no
    ///        announcement. Inside the signed struct: the announcement asserts
    ///        that this offer was stealth-derived for this recipient, and a
    ///        relayer free to choose it could attach a fabricated derivation to
    ///        a genuine offer, or suppress the real one. Signing it costs a
    ///        hash and makes the announcement as authentic as the offer.
    /// @param viewTag First byte of the shared secret; lets a scanner discard
    ///        ~255/256 of announcements on one hash. Also signed.
    function approveWithSig(
        address from,
        address to,
        uint256 tokenId,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag
    ) external {
        if (to == from) revert TransferToSelf();
        if (block.timestamp > deadline) revert SignatureExpired();
        if (nonce != nonces[from]) revert InvalidNonce();
        if (ownerOf(tokenId) != from) revert NotNameOwner();

        if (
            !SignatureChecker.isValidSignatureNow(
                from,
                _approveDigest(
                    from,
                    to,
                    tokenId,
                    keccak256(ephemeralPubKey),
                    viewTag,
                    nonce,
                    deadline
                ),
                sig
            )
        ) revert InvalidSignature();

        unchecked {
            nonces[from] = nonce + 1;
        }
        _approve(to, tokenId);

        if (ephemeralPubKey.length != 0)
            _announce(to, tokenId, ephemeralPubKey, viewTag);
    }

    /// @dev Split out of `approveWithSig` for the same stack reason as
    ///      `_approveDigest`.
    function _announce(
        address to,
        uint256 tokenId,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag
    ) private {
        // ERC-5564 ERC-721 metadata layout: view tag, then the transferFrom
        // selector, the token contract and the token id, so a scanner that
        // matches the view tag learns what is offered without a second lookup.
        emit Announcement(
            STEALTH_SCHEME_ID,
            to,
            msg.sender,
            ephemeralPubKey,
            abi.encodePacked(viewTag, bytes4(0x23b872dd), address(this), tokenId)
        );
    }

    /// @dev Split out of `approveWithSig` only to keep that function's stack
    ///      within the EVM's 16-slot reach.
    function _approveDigest(
        address from,
        address to,
        uint256 tokenId,
        bytes32 ephemeralPubKeyHash,
        bytes1 viewTag,
        uint256 nonce,
        uint256 deadline
    ) private view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    DOMAIN_SEPARATOR(),
                    keccak256(
                        abi.encode(
                            APPROVE_TYPEHASH,
                            from,
                            to,
                            tokenId,
                            ephemeralPubKeyHash,
                            viewTag,
                            nonce,
                            deadline
                        )
                    )
                )
            );
    }

    /// @notice Take `tokenId` from `from`, signed by the recipient `to`: the
    ///         `transferFrom` half. Only the open offer number `offer` to `to`
    ///         can be claimed; every transfer or re-registration clears it.
    function claimWithSig(
        address from,
        address to,
        uint256 tokenId,
        uint256 offer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (nonce != nonces[to]) revert InvalidNonce();
        // Grace-aware ownerOf reverts once expired, so a lapsed name cannot be
        // moved out from under the person about to re-register it.
        if (ownerOf(tokenId) != from) revert NotNameOwner();
        if (getApproved(tokenId) != to || offer != offers[tokenId])
            revert NotOffered();

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        CLAIM_TYPEHASH,
                        from,
                        to,
                        tokenId,
                        offer,
                        nonce,
                        deadline
                    )
                )
            )
        );
        if (!SignatureChecker.isValidSignatureNow(to, digest, sig))
            revert InvalidSignature();

        unchecked {
            nonces[to] = nonce + 1;
        }
        // _transfer, not a raw write: the auto-reclaim hook below must fire so
        // the registry node and its subnames follow the token.
        _transfer(from, to, tokenId);
    }

    /// @dev Auto-reclaim: an NFT transfer re-points the 2LD's ENS registry node
    ///      to the new holder, so the registry "manager" always tracks the token
    ///      — no separate reclaim, and the previous owner can no longer manage
    ///      the name or its subnames after a sale. Skips mint/burn (registration
    ///      sets the registry owner itself) and is a no-op if not live.
    ///      A transfer not made by a controller first calls `bonaFideHook`, which
    ///      reverts for a listed name whose recipient has not accepted the current
    ///      terms.
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 firstTokenId,
        uint256 batchSize
    ) internal override {
        super._beforeTokenTransfer(from, to, firstTokenId, batchSize);
        if (from != address(0) && to != address(0)) {
            if (bonaFideHook != address(0) && !controllers[msg.sender]) {
                IBonaFideTerms(bonaFideHook).consumeTransfer(
                    firstTokenId,
                    from,
                    to,
                    offers[firstTokenId],
                    labelOf[firstTokenId]
                );
            }
            if (ens.owner(baseNode) == address(this)) {
                ens.setSubnodeOwner(baseNode, bytes32(firstTokenId), to);
            }
        }
    }

    /// @dev ERC-721 metadata. Delegates to the swappable renderer, passing the
    ///      stored plaintext label so the NFT title is the domain name.
    function tokenURI(
        uint256 tokenId
    ) public view override returns (string memory) {
        _requireMinted(tokenId);
        if (metadataRenderer == address(0)) return "";
        return
            IMetadataRenderer(metadataRenderer).tokenURI(
                tokenId,
                labelOf[tokenId]
            );
    }

    function supportsInterface(
        bytes4 interfaceID
    ) public view override(ERC721Enumerable, IERC165) returns (bool) {
        return
            interfaceID == INTERFACE_META_ID ||
            interfaceID == RECLAIM_ID ||
            super.supportsInterface(interfaceID);
    }
}
