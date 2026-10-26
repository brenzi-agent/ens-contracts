//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {BaseRegistrarImplementation} from "../ethregistrar/BaseRegistrarImplementation.sol";
import {StringUtils} from "../utils/StringUtils.sol";
import {Resolver} from "../resolvers/Resolver.sol";
import {ENS} from "../registry/ENS.sol";
import {IETHRegistrarController, IPriceOracle} from "../ethregistrar/IETHRegistrarController.sol";
import {IPriceOracleUSD} from "../ethregistrar/IPriceOracleUSD.sol";
import {INamePolicy, INamePolicyBinding} from "./INamePolicy.sol";

/// @dev `clearRecords` lives on ResolverBase, not the Resolver interface the
///      controller already imports. Declared minimally rather than pulling the
///      whole resolver in.
interface IClearableResolver {
    function clearRecords(bytes32 node) external;
}

uint256 constant MIN_REGISTRATION = 730 days;
uint256 constant MAX_SPONSORED_REGISTRATION = 4015 days;

/// @dev Fork of ETHRegistrarController with additional access controls:
///      - Minimum name length gate (admin can lower monotonically)
///      - Reserved names (admin-managed blocklist)
///      - NFT gate (optional, for .testing TLD)
///
///      Deployed behind an ERC1967 proxy (UUPS). The implementation has
///      its initializers disabled in the constructor; storage lives in
///      the proxy and is preserved across upgrades.
contract SimplexController is
    Initializable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable,
    IETHRegistrarController,
    ERC165
{
    using StringUtils for *;

    uint256 public constant MIN_REGISTRATION_DURATION = MIN_REGISTRATION;
    uint256 public constant MIN_RENEWAL_DURATION = 365 days;
    uint256 public constant MAX_REGISTRATION_DURATION = 1095 days;
    uint256 public constant MAX_SPONSORED_REGISTRATION_DURATION = MAX_SPONSORED_REGISTRATION;

    // Manual reentrancy guard (see `_reentrancyStatus` + `nonReentrant`).
    // Implemented by hand rather than inheriting ReentrancyGuardUpgradeable so
    // the guard's state appends to the reserved `__gap` instead of inserting a
    // new base contract's storage ahead of existing variables — see
    // docs/upgrades.md (this contract is already deployed behind a UUPS proxy).
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    // Was immutable in the non-upgradeable version. Converted to plain
    // storage so values survive a UUPS upgrade rather than being baked
    // into each implementation's bytecode.
    ENS public ens;
    BaseRegistrarImplementation base;
    uint256 public minCommitmentAge;
    uint256 public maxCommitmentAge;
    // Were `reverseRegistrar` and `defaultReverseRegistrar`. SNRC runs no reverse
    // resolution, so nothing writes them and the initializer no longer takes
    // them. The two slots are kept rather than deleted: removing them would
    // shift every variable below, and reserving them means reverse resolution
    // can be reintroduced in an upgrade without a layout migration.
    address private _unusedReverseRegistrar;
    address private _unusedDefaultReverseRegistrar;
    IPriceOracleUSD public prices;
    bytes32 public tldNode;
    /// @dev Unread on-chain since reverse resolution was removed, but kept: it is
    ///      a public getter indexers use to identify the TLD, and deleting a
    ///      storage variable would shift every slot below it.
    string public tldSuffix;

    mapping(bytes32 => uint256) public commitments;

    // --- Simplex additions ---
    uint8 public minCharLength;
    mapping(bytes32 => uint8) private _unusedReservedNames;
    IERC721 public smpxNft;
    bool public nftGateEnabled;
    // Was `priceOracleFrozen`. `freezePriceOracle` is gone: the Chainlink feed is
    // immutable inside the oracle, so a frozen oracle whose feed is retired would
    // break registration and renewal permanently. The slot is kept so the layout
    // does not shift.
    bool private _unusedPriceOracleFrozen;

    error CommitmentNotFound(bytes32 commitment);
    error CommitmentTooNew(bytes32 commitment, uint256 minimumCommitmentTimestamp, uint256 currentTimestamp);
    error CommitmentTooOld(bytes32 commitment, uint256 maximumCommitmentTimestamp, uint256 currentTimestamp);
    error NameNotAvailable(string name);
    error DurationTooShort(uint256 duration);
    error DurationTooLong(uint256 duration);
    error ResolverRequiredWhenDataSupplied();
    error ReverseRecordNotSupported();
    error UnexpiredCommitmentExists(bytes32 commitment);
    error InsufficientValue();
    error TransferFailed();
    struct SimplexConfig {
        bytes32 tldNode;
        string tldSuffix;
        uint8 minCharLength;
        IERC721 smpxNft;
        bool nftGateEnabled;
    }

    error MinCommitmentAgeZero();
    error MaxCommitmentAgeTooLow();
    error MaxCommitmentAgeTooHigh();
    error NameTooShort(string name, uint8 minLength);
    error NameReserved(string name);
    error NftRequired();
    error MinCharLengthCanOnlyDecrease();
    error MinCharLengthZero();
    error NftGateCanOnlyBeDisabled();
    error ZeroAddress();
    error NotBeneficiary();
    error NotOwnerOrBeneficiary();
    error AlreadyFrozen();
    error Frozen();
    error PublicSalesClosed();
    error OwnerMustBeCaller();
    error NotSponsor();

    event NameRegistered(
        string label,
        bytes32 indexed labelhash,
        address indexed owner,
        uint256 baseCost,
        uint256 premium,
        uint256 expires,
        bytes32 referrer
    );

    event NameRenewed(
        string label,
        bytes32 indexed labelhash,
        uint256 cost,
        uint256 expires,
        bytes32 referrer
    );

    event MinCharLengthChanged(uint8 newMinCharLength);
    event NftGateDisabled();
    event PriceOracleChanged(IPriceOracleUSD indexed newOracle);
    event BeneficiaryChanged(address indexed beneficiary);
    event SponsorChanged(address indexed sponsor);
    event DefaultResolverChanged(address indexed resolver);
    event NamePolicyChanged(address indexed namePolicy);
    event PublicSalesOpenChanged(bool open);
    event ContractFrozen();

    error ReentrantCall();
    error NamePolicyMismatch();

    /// @dev Manual `nonReentrant`. A freshly-zero `_reentrancyStatus` (the case
    ///      for the already-deployed instance, whose `initialize` does not
    ///      re-run on upgrade) reads as not-entered, so the guard is correct
    ///      without a reinitializer; `initialize` seeds it to `_NOT_ENTERED`
    ///      for fresh deploys to get the cheaper steady-state cost.
    modifier onlySponsor() {
        if (msg.sender != sponsor) revert NotSponsor();
        _;
    }

    /// @dev Restrictive actions are held by the owner and the guardian both, so
    ///      they can be taken immediately rather than waiting on the owner's
    ///      timelock. See docs/plans/names-v2-launch-to-freeze-plan.md.
    modifier onlyOwnerOrBeneficiary() {
        if (msg.sender != owner() && msg.sender != beneficiary)
            revert NotOwnerOrBeneficiary();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyStatus == _ENTERED) revert ReentrantCall();
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        BaseRegistrarImplementation _base,
        IPriceOracleUSD _prices,
        uint256 _minCommitmentAge,
        uint256 _maxCommitmentAge,
        ENS _ens,
        SimplexConfig memory _config,
        address _owner
    ) public initializer {
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
        _reentrancyStatus = _NOT_ENTERED;

        // Zero would let an observer commit and register in the same block as the
        // reveal they are front-running: `commitmentTimestamp + 0 > block.timestamp`
        // is false when both land in one block. Any non-zero value closes that.
        if (_minCommitmentAge == 0) revert MinCommitmentAgeZero();
        if (_maxCommitmentAge <= _minCommitmentAge) revert MaxCommitmentAgeTooLow();
        // Sanity cap on how long a commitment may sit before it expires.
        // The previous form compared duration to block.timestamp (~1.7e9),
        // which never triggered for any plausible deploy value.
        if (_maxCommitmentAge > 30 days) revert MaxCommitmentAgeTooHigh();

        ens = _ens;
        base = _base;
        prices = _prices;
        minCommitmentAge = _minCommitmentAge;
        maxCommitmentAge = _maxCommitmentAge;
        tldNode = _config.tldNode;
        tldSuffix = _config.tldSuffix;
        minCharLength = _config.minCharLength;
        smpxNft = _config.smpxNft;
        nftGateEnabled = _config.nftGateEnabled;

        if (_owner != msg.sender) {
            _transferOwnership(_owner);
        }
    }

    function _authorizeUpgrade(address) internal view override onlyOwner {
        if (frozen) revert Frozen();
    }

    /// @notice Recover ERC20 tokens sent to this contract by mistake.
    function recoverFunds(
        address _token,
        address _to,
        uint256 _amount
    ) external onlyOwner {
        IERC20(_token).transfer(_to, _amount);
    }

    // --- names v2: governance ---

    /// @notice Set the guardian key. Callable by the owner while unset, and by the
    ///         beneficiary itself afterwards, so the owner cannot take it back.
    function setBeneficiary(address newBeneficiary) external {
        if (newBeneficiary == address(0)) revert ZeroAddress();
        if (beneficiary == address(0)) {
            if (msg.sender != owner()) revert NotBeneficiary();
        } else if (msg.sender != beneficiary) {
            revert NotBeneficiary();
        }
        beneficiary = newBeneficiary;
        emit BeneficiaryChanged(newBeneficiary);
    }

    /// @notice The contract allowed to call `registerSponsored` and
    ///         `renewSponsored`: it stores the registrar allowances and verifies
    ///         the owner's signature. Fixed by `freeze`, like the implementation.
    function setSponsor(address newSponsor) external onlyOwner {
        if (frozen) revert Frozen();
        sponsor = newSponsor;
        emit SponsorChanged(newSponsor);
    }

    /// @notice The resolver new registrations point at. Only registrations against
    ///         this resolver are granted edit credits.
    function setDefaultResolver(address resolver) external onlyOwner {
        defaultResolver = resolver;
        // Never unset. Rotating the default must not strand the records written
        // against the previous one — see `_retireStaleRecords`.
        if (resolver != address(0)) wasDefaultResolver[resolver] = true;
        emit DefaultResolverChanged(resolver);
    }

    /// @notice Survives `freeze`.
    function setNamePolicy(address newNamePolicy) external onlyOwner {
        if (newNamePolicy == address(0)) revert ZeroAddress();
        if (INamePolicyBinding(newNamePolicy).controller() != address(this))
            revert NamePolicyMismatch();
        INamePolicy(newNamePolicy).isReserved(0);
        namePolicy = newNamePolicy;
        emit NamePolicyChanged(newNamePolicy);
    }

    /// @notice Open or close the payable registration path. Two-way until `freeze`,
    ///         so it is also the pause switch. Held by the guardian as well as the
    ///         owner because an exploit in the payable path accrues harm per block.
    function setPublicSalesOpen(bool open) external onlyOwnerOrBeneficiary {
        if (frozen) revert Frozen();
        publicSalesOpen = open;
        emit PublicSalesOpenChanged(open);
    }

    /// @notice One-way. Makes the implementation, the name policy's implementation and the
    ///         sponsor permanent and locks the sales switch in its current position. Everything
    ///         else the owner can do survives, including `setPriceOracle` and the name policy's
    ///         setters.
    /// @dev    Refuses while sales are closed. Freezing then would shut the
    ///         payable path permanently — `setPublicSalesOpen` and the upgrade
    ///         escape are disabled by the same flag — and the ordering is
    ///         racy in practice: the pause is the guardian's, immediate, while
    ///         the freeze is the owner's behind a timelock, so a pause answering
    ///         an incident can land between a queued freeze and its execution.
    ///         With this check that race fails safe: the freeze reverts and is
    ///         re-queued. Also refuses while no sponsor is set, which would close
    ///         the sponsored path for good.
    function freeze() external onlyOwner {
        if (frozen) revert AlreadyFrozen();
        if (!publicSalesOpen) revert PublicSalesClosed();
        if (sponsor == address(0)) revert ZeroAddress();
        frozen = true;
        emit ContractFrozen();
    }

    // --- Simplex admin functions ---

    function setMinCharLength(uint8 newMinCharLength) external onlyOwner {
        // Monotonic decrease is the policy; zero is not a policy but a mistake,
        // and it is unrecoverable — the setter only goes down, so a namespace
        // that admits the empty label can never be walked back.
        if (newMinCharLength == 0) revert MinCharLengthZero();
        if (newMinCharLength >= minCharLength) revert MinCharLengthCanOnlyDecrease();
        minCharLength = newMinCharLength;
        emit MinCharLengthChanged(newMinCharLength);
    }

    function disableNftGate() external onlyOwner {
        if (!nftGateEnabled) revert NftGateCanOnlyBeDisabled();
        nftGateEnabled = false;
        emit NftGateDisabled();
    }

    /// @notice Swap the active price oracle. Survives `freeze`, and must: the
    ///         Chainlink feed is immutable inside the oracle, so a retired feed
    ///         would otherwise end registration and renewal permanently.
    function setPriceOracle(IPriceOracleUSD newOracle) external onlyOwner {
        if (address(newOracle) == address(0)) revert ZeroAddress();
        prices = newOracle;
        emit PriceOracleChanged(newOracle);
    }

    // --- ENS controller functions (unchanged logic, added gates) ---

    function rentPrice(
        string calldata label,
        uint256 duration
    ) public view override returns (IPriceOracle.Price memory price) {
        bytes32 labelhash = keccak256(bytes(label));
        price = _rentPrice(label, labelhash, duration);
    }

    function valid(string calldata label) public view returns (bool) {
        return label.strlen() >= minCharLength;
    }

    /// @notice Whether `label` can actually be registered. Reserved names are
    ///         included: they are refused at registration, so reporting them as
    ///         available would have a caller burn a commitment and wait out
    ///         `minCommitmentAge` only to revert `NameReserved`.
    function available(
        string calldata label
    ) public view override returns (bool) {
        bytes32 labelhash = keccak256(bytes(label));
        return
            _available(label, labelhash) &&
            !INamePolicy(namePolicy).isReserved(labelhash);
    }

    function makeCommitment(
        Registration calldata registration
    ) public pure override returns (bytes32 commitment) {
        if (registration.data.length > 0 && registration.resolver == address(0))
            revert ResolverRequiredWhenDataSupplied();

        // `.simplex` runs no reverse registrar: nothing here resolves an address
        // back to a name, so the upstream struct field is refused rather than
        // silently dropped. Keeping the field keeps IETHRegistrarController's
        // ABI intact for tooling that encodes against it.
        if (registration.reverseRecord != 0) revert ReverseRecordNotSupported();

        if (registration.duration < MIN_REGISTRATION_DURATION)
            revert DurationTooShort(registration.duration);

        return keccak256(abi.encode(registration));
    }

    function commit(bytes32 commitment) public override nonReentrant {
        if (commitments[commitment] + maxCommitmentAge >= block.timestamp) {
            revert UnexpiredCommitmentExists(commitment);
        }
        commitments[commitment] = block.timestamp;
    }

    /// @param checkNft Skipped on the credited path, where `msg.sender` is the
    ///        sponsor rather than the buyer.
    function _checkSimplexGates(
        string calldata label,
        bool checkNft
    ) internal view {
        if (label.strlen() < minCharLength)
            revert NameTooShort(label, minCharLength);
        if (checkNft && nftGateEnabled && smpxNft.balanceOf(msg.sender) == 0)
            revert NftRequired();
    }

    /// @dev The list price of `label` for `duration`, in attoUSD.
    /// @dev A re-registered name must not inherit the previous owner's records.
    ///      Nothing clears them on expiry: the registry keeps the node's resolver
    ///      pointer and the resolver keeps its data, so without this a squatter
    ///      could point `simplex.contact` at their own link, let the name lapse,
    ///      and keep receiving the next owner's conversations.
    ///
    ///      `clearRecords` bumps the node's record version, invalidating every
    ///      key in one write, and the controller is `trustedETHController` so it
    ///      is authorised. Only the default resolver is touched: calling into an
    ///      arbitrary user-supplied resolver could revert and brick the
    ///      registration. A node whose previous owner pointed it at some other
    ///      resolver keeps that pointer unless the new registration supplies one
    ///      — see docs/security.md.
    ///
    ///      A first registration is a no-op: the node has no resolver yet.
    function _retireStaleRecords(bytes32 node) private {
        address stale = ens.resolver(node);
        if (stale != address(0) && wasDefaultResolver[stale]) {
            IClearableResolver(stale).clearRecords(node);
        }
    }

    function rentPriceUSD(
        string calldata label,
        uint256 duration
    ) external view returns (IPriceOracle.Price memory) {
        return
            prices.priceUSD(
                label,
                base.nameExpires(uint256(keccak256(bytes(label)))),
                duration
            );
    }

    /// @notice Register and pay. Gated by the public sales switch; the credited
    ///         and reserved paths are not. Registers to the caller only:
    ///         registering for someone else goes through `SimplexSponsor` and
    ///         needs their signature.
    function register(
        Registration calldata registration
    ) public payable override nonReentrant {
        if (!publicSalesOpen) revert PublicSalesClosed();
        if (registration.owner != msg.sender) revert OwnerMustBeCaller();
        if (registration.duration > MAX_REGISTRATION_DURATION)
            revert DurationTooLong(registration.duration);
        _checkSimplexGates(registration.label, true);

        bytes32 labelhash = keccak256(bytes(registration.label));
        IPriceOracle.Price memory price = _rentPrice(
            registration.label,
            labelhash,
            registration.duration
        );
        uint256 totalPrice = price.base + price.premium;
        if (msg.value < totalPrice) revert InsufficientValue();

        _registerCore(registration, labelhash, price);

        if (msg.value > totalPrice) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value - totalPrice}("");
            if (!ok) revert TransferFailed();
        }
    }

    /// @notice Register with no value attached, callable only by `sponsor`.
    ///         The fee would have gone to the controller and been withdrawn back
    ///         to the same treasury, so it is removed rather than performed.
    function registerSponsored(
        Registration calldata registration
    ) external onlySponsor nonReentrant {
        if (registration.duration > MAX_SPONSORED_REGISTRATION_DURATION)
            revert DurationTooLong(registration.duration);
        _checkSimplexGates(registration.label, false);

        bytes32 labelhash = keccak256(bytes(registration.label));

        // Zero cost in the event, and no `_rentPrice` call: nothing is paid on
        // this path, so the wei figure would be a quote rather than a payment —
        // and reading it would couple the sponsored flow to the ETH/USD feed,
        // which is the one dependency this path exists without. What was
        // actually consumed is in the sponsor's `RegistrarAllowanceSpent`, in attoUSD.
        _registerCore(registration, labelhash, IPriceOracle.Price(0, 0));
    }

    /// @dev Everything both registration paths share: availability, the
    ///      commit/reveal window, the mint and the records.
    function _registerCore(
        Registration calldata registration,
        bytes32 labelhash,
        IPriceOracle.Price memory price
    ) private returns (uint256 expires) {
        if (!_available(registration.label, labelhash))
            revert NameNotAvailable(registration.label);

        bytes32 commitment = makeCommitment(registration);
        uint256 commitmentTimestamp = commitments[commitment];

        if (commitmentTimestamp + minCommitmentAge > block.timestamp)
            revert CommitmentTooNew(
                commitment,
                commitmentTimestamp + minCommitmentAge,
                block.timestamp
            );

        if (commitmentTimestamp + maxCommitmentAge <= block.timestamp) {
            if (commitmentTimestamp == 0) revert CommitmentNotFound(commitment);
            revert CommitmentTooOld(
                commitment,
                commitmentTimestamp + maxCommitmentAge,
                block.timestamp
            );
        }

        delete (commitments[commitment]);

        INamePolicy(namePolicy).consumeRegistration(
            registration.label,
            labelhash,
            commitment,
            registration.owner
        );

        bytes32 namehash = keccak256(abi.encodePacked(tldNode, labelhash));

        // Before the mint and before any new record is written: clearing after
        // `multicallWithNodeCheck` would wipe the records this registration just
        // set, since the version bump invalidates every key at once.
        _retireStaleRecords(namehash);

        if (registration.resolver == address(0)) {
            expires = base.registerWithLabel(
                registration.label,
                registration.owner,
                registration.duration
            );
        } else {
            expires = base.registerWithLabel(
                registration.label,
                address(this),
                registration.duration
            );

            ens.setRecord(
                namehash,
                address(this),
                registration.resolver,
                0
            );
            if (registration.data.length > 0)
                Resolver(registration.resolver).multicallWithNodeCheck(
                    namehash,
                    registration.data
                );

            base.transferFrom(
                address(this),
                registration.owner,
                uint256(labelhash)
            );
        }

        emit NameRegistered(
            registration.label,
            labelhash,
            registration.owner,
            price.base,
            price.premium,
            expires,
            registration.referrer
        );
    }

    function renew(
        string calldata label,
        uint256 duration,
        bytes32 referrer
    ) external payable override nonReentrant {
        bytes32 labelhash = keccak256(bytes(label));

        IPriceOracle.Price memory price = _rentPrice(label, labelhash, duration);
        if (msg.value < price.base) revert InsufficientValue();

        _renewCore(label, labelhash, duration, price.base, referrer, MAX_REGISTRATION_DURATION);

        if (msg.value > price.base) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value - price.base}("");
            if (!ok) revert TransferFailed();
        }
    }

    /// @notice Renew with no value attached, callable only by `sponsor`.
    function renewSponsored(
        string calldata label,
        uint256 duration,
        bytes32 referrer
    ) external onlySponsor nonReentrant {
        bytes32 labelhash = keccak256(bytes(label));
        // zero cost, and no feed read — see `registerSponsored`
        _renewCore(label, labelhash, duration, 0, referrer, MAX_SPONSORED_REGISTRATION_DURATION);
    }

    function _renewCore(
        string calldata label,
        bytes32 labelhash,
        uint256 duration,
        uint256 cost,
        bytes32 referrer,
        uint256 horizon
    ) private returns (uint256 expires) {
        if (duration < MIN_RENEWAL_DURATION) revert DurationTooShort(duration);
        if (INamePolicy(namePolicy).isReserved(labelhash))
            revert NameReserved(label);

        expires = base.renew(uint256(labelhash), duration);
        if (expires > block.timestamp + horizon) revert DurationTooLong(duration);

        emit NameRenewed(label, labelhash, cost, expires, referrer);
    }

    /// @notice Pays the beneficiary, never `owner()`, so revenue is independent of
    ///         the admin key. Permissionless to call.
    function withdraw() public nonReentrant {
        address payee = beneficiary;
        if (payee == address(0)) revert ZeroAddress();
        (bool ok, ) = payable(payee).call{value: address(this).balance}("");
        if (!ok) revert TransferFailed();
    }

    function supportsInterface(
        bytes4 interfaceID
    ) public view override returns (bool) {
        return
            interfaceID == type(IETHRegistrarController).interfaceId ||
            super.supportsInterface(interfaceID);
    }

    /* Internal functions */

    function _rentPrice(
        string calldata label,
        bytes32 labelhash,
        uint256 duration
    ) internal view returns (IPriceOracle.Price memory price) {
        price = prices.price(
            label,
            base.nameExpires(uint256(labelhash)),
            duration
        );
    }

    function _available(
        string calldata label,
        bytes32 labelhash
    ) internal view returns (bool) {
        return valid(label) && base.available(uint256(labelhash));
    }

    /// @dev Reserved storage to allow new state variables in upgrades
    ///      without colliding with child contracts. Use indices from the
    ///      front of the array; the size shrinks as state variables are
    ///      added in future versions.
    // Decremented from 50 to 49 when `priceOracleFrozen` was added in the
    // setPriceOracle / freezePriceOracle change. Decrement further whenever
    // new state variables land here.
    // 49 -> 48 when `_reentrancyStatus` was added (reentrancy guard).
    uint256 private _reentrancyStatus;

    // --- names v2: governance, sponsor and pricing. 48 -> 45. ---
    // Slot 1: beneficiary + frozen pack together.
    /// @dev Guardian key: the registrar allowance (on the sponsor), the sales switch, and `withdraw`'s payee.
    address public beneficiary;
    /// @dev One-way. Blocks upgrades, the sales switch and the sponsor; nothing else.
    bool public frozen;
    address public sponsor;
    // Slot 3: defaultResolver + publicSalesOpen pack together.
    /// @dev The resolver `registerReserved` points a brand's name at.
    address public defaultResolver;
    /// @dev Gates the payable path only. Credited and reserved registrations ignore it.
    bool public publicSalesOpen;
    /// @dev Every resolver that has ever been the default, never cleared. The
    ///      set this contract may call `clearRecords` on: each entry is a
    ///      resolver we deployed and that trusts this controller, so the call
    ///      cannot revert or burn the caller's gas. Testing `== defaultResolver`
    ///      instead would silently stop retiring records the moment the default
    ///      was rotated, quietly reopening the stale-record leak for every name
    ///      still pointing at the old one.
    mapping(address => bool) public wasDefaultResolver;
    address public namePolicy;

    uint256[43] private __gap;
}
