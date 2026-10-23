# SimplexController upgrade & storage-layout invariants

`SimplexController` is the only **upgradeable** contract in the SNRC deployment
(ERC-1967 UUPS proxy; `_authorizeUpgrade` is `onlyOwner`). A UUPS upgrade swaps
the implementation behind a proxy whose storage persists — so the new
implementation **must keep the exact storage layout** of the old one, only
appending. Get this wrong and existing values (prices, reserved names, the
sponsor, …) silently read from the wrong slots.

Upgradeability is not permanent. `freeze()` is one-way and makes
`_authorizeUpgrade` revert `Frozen`, which is what fixes the implementation at
lockdown; everything in this document applies up to that point and not after.

## Storage model

```
contract SimplexController is
    Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, IETHRegistrarController, ERC165
```

Slots are laid out base-contracts-first. The OZ upgradeable parents
(`Initializable`, `Ownable2Step`, `UUPS`) reserve their own slots and carry
their own gaps — leave them alone. In practice they occupy roughly 250 slots, so
this contract's own variables start well past slot 250. After them come
`ens`, `base`, `minCommitmentAge`, `maxCommitmentAge`, two reserved slots
(below), `prices`, `tldNode`, `tldSuffix`, `commitments`, `minCharLength`,
`reservedNames`, `smpxNft` + `nftGateEnabled` + `_unusedPriceOracleFrozen`
(packed), `_reentrancyStatus`, then the names-v2 block:

```solidity
address public beneficiary;                        // packs with `frozen`
bool    public frozen;
address public sponsor;
address public defaultResolver;                    // packs with `publicSalesOpen`
bool    public publicSalesOpen;
mapping(address => bool) public wasDefaultResolver;
address public bonaFideHook;

uint256[43] private __gap;   // shrinks as state is added
```

`__gap` was `[50]`; `[49]` when `priceOracleFrozen` landed, `[48]` with
`_reentrancyStatus`, `[44]` with the four names-v2 slots, and `[43]` with
`bonaFideHook`. It is the budget for future state.

`sponsor` reuses the slot of names-v2's `registrarAllowance`, which no deployed
proxy has held; a mapping's own slot is never written, so it reads as zero under
either type. This is the one sanctioned exception to invariant 2.

**Reserved slots.** Two kinds of placeholder exist, and both are deliberate:

- `_unusedPriceOracleFrozen` — was `priceOracleFrozen`, kept when
  `freezePriceOracle` was removed. Pricing must stay changeable, because the
  Chainlink feed is `immutable` inside the oracle and a retired feed would
  otherwise end registration and renewal forever.
- `_unusedReverseRegistrar`, `_unusedDefaultReverseRegistrar` — were the two
  reverse-registrar references, kept when reverse resolution was removed.

Neither is written by anything. They exist so removing a feature does not shift
every slot below it, and so the feature can be reintroduced by re-typing the slot
rather than migrating storage. **Removing a variable is not a substitute for
reserving its slot** — see invariant 2.

### `Reason` is storage

`reservedNames` holds `Reason`, and an enum is stored as its member's position.
Once `.simplex` has reservations, reordering or removing a member relabels every
name reserved under it, with nothing on chain to detect it. Treat the enum as
append-only from then on, and keep `None` at 0 — `delete` writes zero.

## Invariants (do not break these)

1. **Append only, from the front of `__gap`.** A new state variable is declared
   immediately *before* `__gap`, and `__gap`'s size is decremented by the number
   of 32-byte slots it consumes (one slot for a `mapping`, `address`, `bool`,
   `uintN`, `bytes32`; more for larger structs). Net slot count is unchanged.
2. **Never reorder, remove, retype, or rename-with-different-type** an existing
   state variable. Renaming with the identical type is fine (layout is by
   position+type, not name); changing the type or order corrupts every slot
   after it.
3. **Never reorder the base contracts** in the `is (...)` list — that also moves
   storage.
4. `constant` / `immutable` values are not in storage and may be changed or added
   freely.

### Adding a variable — example

```solidity
   mapping(address => bool) public wasDefaultResolver;   // last existing var
+  address public somethingNew;       // new var: takes 1 slot, declared here
-  uint256[44] private __gap;
+  uint256[43] private __gap;         // shrink by 1
```

### Removing a variable — reserve, do not delete

```solidity
-  IReverseRegistrar public reverseRegistrar;
+  address private _unusedReverseRegistrar;   // slot reserved, nothing below moves
```

Same slot count, same slot size. `__gap` is untouched.

## Pre-upgrade checklist

- [ ] **Validate the storage layout against the deployed implementation.** Use
      the OpenZeppelin Upgrades plugin — `upgrades.validateUpgrade(OldImpl,
      NewImpl)` (or `upgrades.upgradeProxy`, which validates first). The plugin
      (`@openzeppelin/hardhat-upgrades`) is **not yet a devDependency** — add it,
      or diff layouts manually with `forge inspect SimplexController storage-layout`
      (old vs new) / Hardhat's `storageLayout` build output.
- [ ] **Run the V2 upgrade test** (issue #9): deploy V1 behind a proxy, populate
      state (reserved names, min char length, NFT gate, oracle, beneficiary,
      the sponsor, the sales switch), upgrade to V2, and assert every V1
      value survives unchanged and the new behaviour works.
- [ ] **Run `test/simplex/TestControllerStorageLayout.test.ts`.** It reads raw
      slots from a deployed proxy and asserts the packing and the reserved slots
      directly, which catches a reorder the OZ plugin would also catch and a
      deleted placeholder it would not.
- [ ] Confirm `_authorizeUpgrade` owner is the intended admin timelock before the
      upgrade tx, and that `frozen()` is still `false` — after `freeze()` there is
      no upgrade path at all.
- [ ] Bump the `__gap` size in the same commit as any new state variable, so the
      two never drift.
