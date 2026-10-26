import hre from 'hardhat'
import {
  encodeFunctionData,
  labelhash,
  namehash,
  parseEther,
  zeroAddress,
  zeroHash,
} from 'viem'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  FAR_FUTURE,
  MIN_REGISTRATION,
  PRICE_BASE,
  PRICE_EXCEPTIONS,
  registerWithCredit,
  signIntent,
  signRegistration,
  YEAR,
  yearPriceUSD,
} from './fixtures/namesV2.js'

const TRADEMARK = 2 // SimplexNamePolicy.Reason.Trademark
const NONE = 0 // SimplexNamePolicy.Reason.None

/**
 * The launch plan, walked end to end on one chain in the order it happens:
 * deployment, the a-priori reservation, the governance handover, the investor
 * window, public opening, brand reservations, and the freeze.
 *
 * Custody is simplified: the admin timelock and both Safes are single hot keys,
 * so this exercises the powers and their ordering rather than the signing
 * mechanics. Everything else is the real sequence — the same calls, by the same
 * roles, in the same order, with the assertions the runbooks ask for.
 *
 * State carries across tests deliberately. There is no fixture reload here; the
 * point is the lifecycle.
 */

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const testClient = await connection.viem.getTestClient()
const [
  deployClient,
  adminClient,
  guardianClient,
  registrarClient,
  aliceClient,
  bobClient,
  brandClient,
  buyerClient,
] = await connection.viem.getWalletClients()
const deployKey = deployClient.account
const admin = adminClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const alice = aliceClient.account
const bob = bobClient.account
const brand = brandClient.account
const buyer = buyerClient.account

const TLD = 'simplex'
const TLD_NODE = namehash(TLD)
const node = (label: string) => namehash(`${label}.${TLD}`)
const ALLOWANCE = 100000n * 10n ** 18n // $100,000
const APRIORI_COUNT = 3000
const APRIORI_BATCH = 150
const aPriori = Array.from(
  { length: APRIORI_COUNT },
  (_, i) => `brand${String(i).padStart(4, '0')}`,
)

let ens: any
let root: any
let baseRegistrar: any
let controller: any
let resolver: any
let subnameRegistrar: any
let renderer: any
let dummyOracle: any
let priceOracle: any
let sponsor: any
let namePolicy: any

const OWNABLE = 'Ownable: caller is not the owner'

async function commitAndRegister(
  reg: any,
  account: any,
  opts: { credit?: boolean; value?: bigint } = {},
) {
  await controller.write.commit([await controller.read.makeCommitment([reg])], {
    account,
  })
  return opts.credit
    ? registerWithCredit(connection, sponsor, reg, { account })
    : controller.write.register([reg], { account, value: opts.value ?? 0n })
}

function registration(label: string, owner: `0x${string}`, extra: any = {}) {
  return {
    label,
    owner,
    duration: extra.duration ?? MIN_REGISTRATION,
    secret: zeroHash,
    resolver: extra.resolver ?? zeroAddress,
    data: extra.data ?? [],
    reverseRecord: 0,
    referrer: zeroHash,
  }
}

describe('launch lifecycle', () => {
  describe('1. deployment — the deploy key owns everything', () => {
    beforeAll(async () => {
      const viem = connection.viem
      ens = await viem.deployContract('ENSRegistry', [])
      root = await viem.deployContract('Root', [ens.address])
      baseRegistrar = await viem.deployContract(
        'BaseRegistrarImplementation',
        [ens.address, TLD_NODE],
      )
      dummyOracle = await viem.deployContract('DummyOracle', [100000000n])
      priceOracle = await viem.deployContract('SimplexPriceOracle', [
        dummyOracle.address,
        8,
        PRICE_BASE,
        PRICE_EXCEPTIONS,
      ])
      renderer = await viem.deployContract('MetadataRenderer', [`.${TLD}`])

      const implementation = await viem.deployContract('SimplexController', [])
      const initData = encodeFunctionData({
        abi: implementation.abi,
        functionName: 'initialize',
        args: [
          baseRegistrar.address,
          priceOracle.address,
          1n, // minCommitmentAge: zero is refused by initialize
          86400n,
          ens.address,
          {
            tldNode: TLD_NODE,
            tldSuffix: `.${TLD}`,
            minCharLength: 6,
            smpxNft: zeroAddress,
            nftGateEnabled: false,
          },
          deployKey.address,
        ],
      })
      const proxy = await viem.deployContract('SimplexControllerProxy', [
        implementation.address,
        initData,
      ])
      controller = await viem.getContractAt('SimplexController', proxy.address)

      subnameRegistrar = await viem.deployContract('SubnameRegistrar', [
        ens.address,
        baseRegistrar.address,
      ])
      resolver = await viem.deployContract('SimplexResolver', [
        ens.address,
        subnameRegistrar.address,
        controller.address,
        zeroAddress,
      ])
      await subnameRegistrar.write.setResolver([resolver.address])
      sponsor = await viem.deployContract('SimplexSponsor', [controller.address])
      const namePolicyImplementation = await viem.deployContract(
        'SimplexNamePolicy',
        [controller.address, baseRegistrar.address],
      )
      const namePolicyProxy = await viem.deployContract(
        'SimplexNamePolicyProxy',
        [namePolicyImplementation.address, '0x'],
      )
      namePolicy = await viem.getContractAt(
        'SimplexNamePolicy',
        namePolicyProxy.address,
      )
    })

    it('gives the TLD to the registrar through Root', async () => {
      await ens.write.setOwner([zeroHash, root.address])
      await root.write.setController([deployKey.address, true])
      await root.write.setSubnodeOwner([
        labelhash(TLD),
        baseRegistrar.address,
      ])
      expect((await ens.read.owner([TLD_NODE])).toLowerCase()).toBe(
        baseRegistrar.address.toLowerCase(),
      )
      expect((await ens.read.owner([zeroHash])).toLowerCase()).toBe(
        root.address.toLowerCase(),
      )
    })

    it('wires the registrar, resolver, renderer, sponsor and name policy', async () => {
      await baseRegistrar.write.addController([controller.address])
      await baseRegistrar.write.setMetadataRenderer([renderer.address])
      await baseRegistrar.write.setMaxLabelLength([63n])
      await baseRegistrar.write.setSubnameHook([subnameRegistrar.address])
      await controller.write.setDefaultResolver([resolver.address])
      await controller.write.setSponsor([sponsor.address])
      await baseRegistrar.write.addController([namePolicy.address])
      await controller.write.setNamePolicy([namePolicy.address])
      await baseRegistrar.write.setNamePolicy([namePolicy.address])

      expect(await baseRegistrar.read.maxLabelLength()).toBe(63n)
      expect((await baseRegistrar.read.subnameHook()).toLowerCase()).toBe(
        subnameRegistrar.address.toLowerCase(),
      )
      expect((await controller.read.defaultResolver()).toLowerCase()).toBe(
        resolver.address.toLowerCase(),
      )
      expect((await controller.read.sponsor()).toLowerCase()).toBe(
        sponsor.address.toLowerCase(),
      )
      expect((await sponsor.read.controller()).toLowerCase()).toBe(
        controller.address.toLowerCase(),
      )
      expect((await controller.read.namePolicy()).toLowerCase()).toBe(
        namePolicy.address.toLowerCase(),
      )
      expect((await baseRegistrar.read.namePolicy()).toLowerCase()).toBe(
        namePolicy.address.toLowerCase(),
      )
    })

    it('leaves sales closed and the TLD unlocked, so the deployment stays reversible', async () => {
      expect(await controller.read.publicSalesOpen()).toBe(false)
      expect(await root.read.locked([labelhash(TLD)])).toBe(false)
      expect(await controller.read.frozen()).toBe(false)
      expect(BigInt(await controller.read.beneficiary())).toBe(0n)
    })
  })

  describe('2. the a-priori reservation — 3000 names, by the deploy key', () => {
    it(`reserves ${APRIORI_COUNT} names in batches of ${APRIORI_BATCH}`, async () => {
      // A reserved name costs about 25k gas. The batch is 150 rather than the
      // 300 the deployment plans, because Hardhat caps a transaction at 2^24 gas
      // against the *estimate*, and its estimator runs about 3x over actual for
      // a loop like this. The assertion below pins the real figure.
      let totalGas = 0n
      for (let i = 0; i < aPriori.length; i += APRIORI_BATCH) {
        const hash = await namePolicy.write.addReservedNames([
          aPriori.slice(i, i + APRIORI_BATCH),
          TRADEMARK,
        ])
        totalGas += (await publicClient.getTransactionReceipt({ hash })).gasUsed
      }
      const perName = totalGas / BigInt(APRIORI_COUNT)
      // recorded so the deployment plan's gas budget can be checked against it
      expect(perName).toBeLessThan(30000n)
      for (const label of ['brand0000', 'brand1499', 'brand2999']) {
        expect(await namePolicy.read.reservedNames([labelhash(label)])).toBe(
          TRADEMARK,
        )
      }
      expect(await namePolicy.read.reservedNames([labelhash('notabrand')])).toBe(
        NONE,
      )
    }, 120000)

    it('a reserved name cannot be registered by anyone', async () => {
      const reg = registration('brand0000', alice.address)
      await controller.write.commit(
        [await controller.read.makeCommitment([reg])],
        { account: alice },
      )
      await expect(
        controller.write.register([reg], { account: alice, value: 0n }),
      ).toBeRevertedWithCustomError('PublicSalesClosed')
    })
  })

  describe('3. the governance handover', () => {
    it('sets the beneficiary first, while it is still unset', async () => {
      await controller.write.setBeneficiary([guardian.address])
      expect((await controller.read.beneficiary()).toLowerCase()).toBe(
        guardian.address.toLowerCase(),
      )
      // the owner has spent its one chance
      await expect(
        controller.write.setBeneficiary([bob.address], { account: deployKey }),
      ).toBeRevertedWithCustomError('NotBeneficiary')
    })

    it('hands the controller over in two steps', async () => {
      await controller.write.transferOwnership([admin.address])
      // still the deploy key until acceptance
      expect((await controller.read.owner()).toLowerCase()).toBe(
        deployKey.address.toLowerCase(),
      )
      await controller.write.acceptOwnership({ account: admin })
      expect((await controller.read.owner()).toLowerCase()).toBe(
        admin.address.toLowerCase(),
      )
    })

    it('hands over the registrar and the root', async () => {
      await baseRegistrar.write.transferOwnership([admin.address])
      await root.write.setController([admin.address, true])
      await root.write.setController([deployKey.address, false])
      await root.write.transferOwnership([admin.address])

      expect((await baseRegistrar.read.owner()).toLowerCase()).toBe(
        admin.address.toLowerCase(),
      )
      expect((await root.read.owner()).toLowerCase()).toBe(
        admin.address.toLowerCase(),
      )
    })

    it('leaves the deploy key powerless everywhere', async () => {
      await expect(
        controller.write.setMinCharLength([5], { account: deployKey }),
      ).toBeRevertedWithString(OWNABLE)
      await expect(
        namePolicy.write.removeReservedNames([['brand0000']], {
          account: deployKey,
        }),
      ).toBeRevertedWithCustomError('NotOwner')
      await expect(
        baseRegistrar.write.addController([bob.address], {
          account: deployKey,
        }),
      ).toBeRevertedWithString(OWNABLE)
      await expect(
        root.write.lock([labelhash(TLD)], { account: deployKey }),
      ).toBeRevertedWithString(OWNABLE)
      await expect(
        root.write.setSubnodeOwner([labelhash(TLD), bob.address], {
          account: deployKey,
        }),
      ).toBeRevertedWithString('Controllable: Caller is not a controller')
    })

    it('and cannot register on the credited path either', async () => {
      const reg = registration('deploykeyname', alice.address)
      await controller.write.commit(
        [await controller.read.makeCommitment([reg])],
        { account: deployKey },
      )
      await expect(
        sponsor.write.registerWithCredit(
          await signRegistration(connection, sponsor, reg),
          { account: deployKey },
        ),
      ).toBeRevertedWithCustomError('InsufficientAllowance')
    })
  })

  describe('4. the guardian funds the registrar', () => {
    it('grants a $100,000 allowance, and only the guardian can', async () => {
      await expect(
        sponsor.write.setRegistrarAllowance([registrar.address, ALLOWANCE], {
          account: admin,
        }),
      ).toBeRevertedWithCustomError('NotBeneficiary')

      await sponsor.write.setRegistrarAllowance(
        [registrar.address, ALLOWANCE],
        { account: guardian },
      )
      expect(await sponsor.read.registrarAllowance([registrar.address])).toBe(
        ALLOWANCE,
      )
    })
  })

  describe('5. the investor window — sponsored only', () => {
    it('the payable path is still shut', async () => {
      const reg = registration('earlybird', buyer.address)
      await controller.write.commit(
        [await controller.read.makeCommitment([reg])],
        { account: buyer },
      )
      await expect(
        controller.write.register([reg], {
          account: buyer,
          value: parseEther('1'),
        }),
      ).toBeRevertedWithCustomError('PublicSalesClosed')
    })

    it('the registrar registers names for users who hold no ETH', async () => {
      const before = await sponsor.read.registrarAllowance([
        registrar.address,
      ])
      for (const [label, owner] of [
        ['alicename', alice.address],
        ['bobsname', bob.address],
        ['investorname', buyer.address],
      ] as const) {
        await commitAndRegister(
          registration(label, owner, { resolver: resolver.address }),
          registrar,
          { credit: true },
        )
        expect(
          (
            await baseRegistrar.read.ownerOf([BigInt(labelhash(label))])
          ).toLowerCase(),
        ).toBe(owner.toLowerCase())
      }
      const spent =
        before - (await sponsor.read.registrarAllowance([registrar.address]))
      expect(spent).toBe(3n * yearPriceUSD(6, 2n))
    })

    it('writes the buyer records at registration, for free', async () => {
      const label = 'withrecords'
      const data = [
        encodeFunctionData({
          abi: resolver.abi,
          functionName: 'setText',
          args: [node(label), 'simplex.contact', 'https://smp/alice'],
        }),
      ]
      await commitAndRegister(
        registration(label, alice.address, {
          resolver: resolver.address,
          data,
        }),
        registrar,
        { credit: true },
      )
      expect(await resolver.read.text([node(label), 'simplex.contact'])).toBe(
        'https://smp/alice',
      )
      // the initial record set costs no edit credit
    })

    it('refuses a name below the character minimum, and a reserved one', async () => {
      const short = registration('short', alice.address)
      await controller.write.commit(
        [await controller.read.makeCommitment([short])],
        { account: registrar },
      )
      await expect(
        sponsor.write.registerWithCredit(
          await signRegistration(connection, sponsor, short),
          { account: registrar },
        ),
      ).toBeRevertedWithCustomErrorFrom(controller, 'NameTooShort')

      const reserved = registration('brand0001', alice.address)
      await controller.write.commit(
        [await controller.read.makeCommitment([reserved])],
        { account: registrar },
      )
      await expect(
        sponsor.write.registerWithCredit(
          await signRegistration(connection, sponsor, reserved),
          { account: registrar },
        ),
      ).toBeRevertedWithCustomErrorFrom(namePolicy, 'NameReserved')
    })
  })

  describe('6. everything the registrar can do on a user behalf', () => {
    const OWNED = 'alicename'

    it('alice holds no ETH from here on', async () => {
      await testClient.setBalance({ address: alice.address, value: 0n })
      expect(await publicClient.getBalance({ address: alice.address })).toBe(0n)
    })

    it('relays a record edit', async () => {
      const m = {
        node: node(OWNED),
        key: 'simplex.contact',
        value: 'https://smp/alice-1',
        nonce: 0n,
        deadline: FAR_FUTURE,
      }
      await resolver.write.setTextWithSig(
        [
          m.node,
          m.key,
          m.value,
          m.nonce,
          m.deadline,
          await signIntent(
            publicClient,
            aliceClient,
            'SimplexResolver',
            resolver.address,
            'SetText',
            m,
          ),
        ],
        { account: registrar },
      )
      expect(
        await resolver.read.text([node(OWNED), 'simplex.contact']),
      ).toBe('https://smp/alice-1')
    })

    it('relays a record clear', async () => {
      const m = { node: node(OWNED), nonce: 1n, deadline: FAR_FUTURE }
      await resolver.write.clearRecordsWithSig(
        [
          m.node,
          m.nonce,
          m.deadline,
          await signIntent(
            publicClient,
            aliceClient,
            'SimplexResolver',
            resolver.address,
            'ClearRecords',
            m,
          ),
        ],
        { account: registrar },
      )
      expect(await resolver.read.text([node(OWNED), 'simplex.contact'])).toBe('')
    })

    it('renews on her behalf', async () => {
      const tokenId = BigInt(labelhash(OWNED))
      const before = await baseRegistrar.read.nameExpires([tokenId])
      const allowanceBefore = await sponsor.read.registrarAllowance([
        registrar.address,
      ])
      await sponsor.write.renewWithCredit([OWNED, YEAR, zeroHash], {
        account: registrar,
      })
      expect(await baseRegistrar.read.nameExpires([tokenId])).toBe(before + YEAR)
      expect(
        allowanceBefore -
          (await sponsor.read.registrarAllowance([registrar.address])),
      ).toBe(yearPriceUSD(6))
      // renewal grants credits too
    })

    it('relays the registry approval and a subname, then a record on it', async () => {
      const approval = {
        owner: alice.address,
        operator: subnameRegistrar.address,
        approved: true,
        nonce: 0n,
        deadline: FAR_FUTURE,
      }
      await ens.write.setApprovalForAllWithSig(
        [
          approval.owner,
          approval.operator,
          approval.approved,
          approval.nonce,
          approval.deadline,
          await signIntent(
            publicClient,
            aliceClient,
            'SimplexENSRegistry',
            ens.address,
            'ApproveAll',
            approval,
          ),
        ],
        { account: registrar },
      )
      expect(
        await ens.read.isApprovedForAll([
          alice.address,
          subnameRegistrar.address,
        ]),
      ).toBe(true)

      const create = {
        parentNode: node(OWNED),
        label: 'work',
        nonce: 0n,
        deadline: FAR_FUTURE,
      }
      await subnameRegistrar.write.createSubnameWithSig(
        [
          create.parentNode,
          create.label,
          create.nonce,
          create.deadline,
          await signIntent(
            publicClient,
            aliceClient,
            'SimplexSubnames',
            subnameRegistrar.address,
            'CreateSubname',
            create,
          ),
        ],
        { account: registrar },
      )
      const sub = namehash(`work.${OWNED}.${TLD}`)
      expect((await subnameRegistrar.read.ownerOf([BigInt(sub)])).toLowerCase()).toBe(
        alice.address.toLowerCase(),
      )

      const m = {
        node: sub,
        key: 'simplex.contact',
        value: 'https://smp/work',
        nonce: 2n,
        deadline: FAR_FUTURE,
      }
      await resolver.write.setTextWithSig(
        [
          m.node,
          m.key,
          m.value,
          m.nonce,
          m.deadline,
          await signIntent(
            publicClient,
            aliceClient,
            'SimplexResolver',
            resolver.address,
            'SetText',
            m,
          ),
        ],
        { account: registrar },
      )
      expect(await resolver.read.text([sub, 'simplex.contact'])).toBe(
        'https://smp/work',
      )
    })

    it('relays a subname deletion', async () => {
      const del = {
        parentNode: node(OWNED),
        label: 'work',
        nonce: 1n,
        deadline: FAR_FUTURE,
      }
      await subnameRegistrar.write.deleteSubnameWithSig(
        [
          del.parentNode,
          del.label,
          del.nonce,
          del.deadline,
          await signIntent(
            publicClient,
            aliceClient,
            'SimplexSubnames',
            subnameRegistrar.address,
            'DeleteSubname',
            del,
          ),
        ],
        { account: registrar },
      )
      expect(
        BigInt(await ens.read.owner([namehash(`work.${OWNED}.${TLD}`)])),
      ).toBe(0n)
    })

    it('relays a gift offer with a stealth announcement and the claim, and the recipient can then act', async () => {
      const tokenId = BigInt(labelhash(OWNED))
      const m = {
        from: alice.address,
        to: bob.address,
        tokenId,
        ephemeralPubKey: `0x${'02'.repeat(33)}` as `0x${string}`,
        viewTag: '0x7f' as `0x${string}`,
        nonce: 0n,
        deadline: FAR_FUTURE,
      }
      await baseRegistrar.write.approveWithSig(
        [
          m.from,
          m.to,
          m.tokenId,
          m.nonce,
          m.deadline,
          await signIntent(
            publicClient,
            aliceClient,
            'SimplexNames',
            baseRegistrar.address,
            'ApproveName',
            m,
          ),
          m.ephemeralPubKey,
          m.viewTag,
        ],
        { account: registrar },
      )
      // an offer moves nothing until the recipient takes it
      expect(
        (await baseRegistrar.read.ownerOf([tokenId])).toLowerCase(),
      ).toBe(alice.address.toLowerCase())

      const c = {
        from: alice.address,
        to: bob.address,
        tokenId,
        offer: await baseRegistrar.read.offers([tokenId]),
        nonce: 0n,
        deadline: FAR_FUTURE,
      }
      await baseRegistrar.write.claimWithSig(
        [
          c.from,
          c.to,
          c.tokenId,
          c.offer,
          c.nonce,
          c.deadline,
          await signIntent(
            publicClient,
            bobClient,
            'SimplexNames',
            baseRegistrar.address,
            'ClaimName',
            c,
          ),
        ],
        { account: registrar },
      )
      expect(
        (await baseRegistrar.read.ownerOf([tokenId])).toLowerCase(),
      ).toBe(bob.address.toLowerCase())
      // auto-reclaim moved the registry node, so bob is now the relayed signer
      expect((await resolver.read.relayedSigner([node(OWNED)])).toLowerCase()).toBe(
        bob.address.toLowerCase(),
      )

      const m2 = {
        node: node(OWNED),
        key: 'simplex.contact',
        value: 'https://smp/bob',
        nonce: 0n,
        deadline: FAR_FUTURE,
      }
      await resolver.write.setTextWithSig(
        [
          m2.node,
          m2.key,
          m2.value,
          m2.nonce,
          m2.deadline,
          await signIntent(
            publicClient,
            bobClient,
            'SimplexResolver',
            resolver.address,
            'SetText',
            m2,
          ),
        ],
        { account: registrar },
      )
      expect(await resolver.read.text([node(OWNED), 'simplex.contact'])).toBe(
        'https://smp/bob',
      )
    })

    it('and alice still never paid gas', async () => {
      expect(await publicClient.getBalance({ address: alice.address })).toBe(0n)
    })
  })

  describe('7. brand reservations during the window', () => {
    it('the guardian reserves a name under threat, immediately', async () => {
      await namePolicy.write.addReservedNames([['newbrand'], TRADEMARK], {
        account: guardian,
      })
      expect(await namePolicy.read.reservedNames([labelhash('newbrand')])).toBe(
        TRADEMARK,
      )
    })

    it('the admin hands it to the brand, resolving with credits', async () => {
      await expect(
        namePolicy.write.registerReserved(
          ['newbrand', brand.address, MIN_REGISTRATION],
          { account: guardian },
        ),
      ).toBeRevertedWithCustomError('NotOwner')

      await namePolicy.write.registerReserved(
        ['newbrand', brand.address, MIN_REGISTRATION],
        { account: admin },
      )
      expect((await ens.read.owner([node('newbrand')])).toLowerCase()).toBe(
        brand.address.toLowerCase(),
      )
      expect((await ens.read.resolver([node('newbrand')])).toLowerCase()).toBe(
        resolver.address.toLowerCase(),
      )
    })

    it('releasing a reserved name is admin-only', async () => {
      await expect(
        namePolicy.write.removeReservedNames([['brand2999']], {
          account: guardian,
        }),
      ).toBeRevertedWithCustomError('NotOwner')
      await namePolicy.write.removeReservedNames([['brand2999']], {
        account: admin,
      })
      expect(await namePolicy.read.reservedNames([labelhash('brand2999')])).toBe(
        NONE,
      )
    })
  })

  describe('8. public sales open', () => {
    it('the guardian opens them', async () => {
      await controller.write.setPublicSalesOpen([true], { account: guardian })
      expect(await controller.read.publicSalesOpen()).toBe(true)
    })

    it('a fresh key registers directly and is refunded the excess', async () => {
      const reg = registration('freshname', buyer.address, {
        resolver: resolver.address,
      })
      await controller.write.commit(
        [await controller.read.makeCommitment([reg])],
        { account: buyer },
      )
      const before = await publicClient.getBalance({ address: buyer.address })
      const hash = await controller.write.register([reg], {
        account: buyer,
        value: 5n * yearPriceUSD(6),
      })
      const receipt = await publicClient.getTransactionReceipt({ hash })
      const after = await publicClient.getBalance({ address: buyer.address })

      expect(before - after).toBe(
        yearPriceUSD(6, 2n) + receipt.gasUsed * receipt.effectiveGasPrice,
      )
      expect(
        (
          await baseRegistrar.read.ownerOf([BigInt(labelhash('freshname'))])
        ).toLowerCase(),
      ).toBe(buyer.address.toLowerCase())
    })

    it('a released name is now buyable, a reserved one still is not', async () => {
      const released = registration('brand2999', buyer.address)
      await controller.write.commit(
        [await controller.read.makeCommitment([released])],
        { account: buyer },
      )
      await controller.write.register([released], {
        account: buyer,
        value: 2n * yearPriceUSD(6),
      })

      const stillReserved = registration('brand0002', buyer.address)
      await controller.write.commit(
        [await controller.read.makeCommitment([stillReserved])],
        { account: buyer },
      )
      await expect(
        controller.write.register([stillReserved], {
          account: buyer,
          value: 2n * yearPriceUSD(6),
        }),
      ).toBeRevertedWithCustomErrorFrom(namePolicy, 'NameReserved')
    })

    it('anyone may renew anyone name — renewal is unauthenticated by design', async () => {
      const tokenId = BigInt(labelhash('freshname'))
      const before = await baseRegistrar.read.nameExpires([tokenId])
      await controller.write.renew(['freshname', YEAR, zeroHash], {
        account: bob,
        value: 2n * yearPriceUSD(6),
      })
      expect(await baseRegistrar.read.nameExpires([tokenId])).toBe(before + YEAR)
    })

    it('the guardian can pause and reopen', async () => {
      await controller.write.setPublicSalesOpen([false], { account: guardian })
      const reg = registration('pausedname', buyer.address)
      await controller.write.commit(
        [await controller.read.makeCommitment([reg])],
        { account: buyer },
      )
      await expect(
        controller.write.register([reg], {
          account: buyer,
          value: 2n * yearPriceUSD(6),
        }),
      ).toBeRevertedWithCustomError('PublicSalesClosed')
      await controller.write.setPublicSalesOpen([true], { account: guardian })
    })

    it('withdraw pays the guardian, and anyone may call it', async () => {
      const balance = await publicClient.getBalance({
        address: controller.address,
      })
      expect(balance).toBeGreaterThan(0n)
      const before = await publicClient.getBalance({ address: guardian.address })
      await controller.write.withdraw({ account: bob })
      expect(
        (await publicClient.getBalance({ address: guardian.address })) - before,
      ).toBe(balance)
    })
  })

  describe('9. the freeze', () => {
    it('locks the TLD, so it can never be re-pointed', async () => {
      await root.write.lock([labelhash(TLD)], { account: admin })
      expect(await root.read.locked([labelhash(TLD)])).toBe(true)
      await expect(
        root.write.setSubnodeOwner([labelhash(TLD), bob.address], {
          account: admin,
        }),
      ).toBeRevertedWithoutReason()
    })

    it('confirms sales are open before the switch is sealed', async () => {
      expect(await controller.read.publicSalesOpen()).toBe(true)
    })

    it('freezes, and only the admin may', async () => {
      await expect(
        controller.write.freeze({ account: guardian }),
      ).toBeRevertedWithString(OWNABLE)
      await controller.write.freeze({ account: admin })
      expect(await controller.read.frozen()).toBe(true)
      await expect(
        controller.write.freeze({ account: admin }),
      ).toBeRevertedWithCustomError('AlreadyFrozen')
    })

    it('the implementation and the sponsor are permanent', async () => {
      const next = await connection.viem.deployContract('SimplexController', [])
      await expect(
        controller.write.upgradeTo([next.address], { account: admin }),
      ).toBeRevertedWithCustomError('Frozen')
      await expect(
        controller.write.upgradeToAndCall([next.address, '0x'], {
          account: admin,
        }),
      ).toBeRevertedWithCustomError('Frozen')
      await expect(
        controller.write.setSponsor([next.address], { account: admin }),
      ).toBeRevertedWithCustomError('Frozen')
    })

    it('the sales switch is sealed in the open position', async () => {
      await expect(
        controller.write.setPublicSalesOpen([false], { account: admin }),
      ).toBeRevertedWithCustomError('Frozen')
      await expect(
        controller.write.setPublicSalesOpen([false], { account: guardian }),
      ).toBeRevertedWithCustomError('Frozen')
      expect(await controller.read.publicSalesOpen()).toBe(true)
    })

    it('brand outreach continues with no horizon', async () => {
      await namePolicy.write.addReservedNames([['latebrand'], TRADEMARK], {
        account: guardian,
      })
      await namePolicy.write.registerReserved(
        ['latebrand', brand.address, MIN_REGISTRATION],
        { account: admin },
      )
      expect((await ens.read.owner([node('latebrand')])).toLowerCase()).toBe(
        brand.address.toLowerCase(),
      )
    })

    it('the namespace can still survive its own price feed', async () => {
      const replacement = await connection.viem.deployContract(
        'SimplexPriceOracle',
        [dummyOracle.address, 8, PRICE_BASE, PRICE_EXCEPTIONS],
      )
      await controller.write.setPriceOracle([replacement.address], {
        account: admin,
      })
      expect((await controller.read.prices()).toLowerCase()).toBe(
        replacement.address.toLowerCase(),
      )
    })

    it('the guardian keeps funding and defunding', async () => {
      await sponsor.write.setRegistrarAllowance([registrar.address, 0n], {
        account: guardian,
      })
      expect(await sponsor.read.registrarAllowance([registrar.address])).toBe(
        0n,
      )
      await sponsor.write.setRegistrarAllowance(
        [registrar.address, ALLOWANCE],
        { account: guardian },
      )
    })

    it('the admin keeps the remaining levers', async () => {
      await controller.write.setMinCharLength([5], { account: admin })
      expect(await controller.read.minCharLength()).toBe(5)
      await controller.write.setDefaultResolver([resolver.address], {
        account: admin,
      })
      await baseRegistrar.write.setMetadataRenderer([renderer.address], {
        account: admin,
      })
      await baseRegistrar.write.addController([bob.address], { account: admin })
      await baseRegistrar.write.removeController([bob.address], {
        account: admin,
      })
    })

    it('and the whole sponsored journey still runs', async () => {
      await commitAndRegister(
        registration('afterfreeze', alice.address, {
          resolver: resolver.address,
        }),
        registrar,
        { credit: true },
      )
      const m = {
        node: node('afterfreeze'),
        key: 'simplex.contact',
        value: 'https://smp/after',
        // her fourth signed intent against this resolver: the counter is per
        // signer, not per name
        nonce: 3n,
        deadline: FAR_FUTURE,
      }
      await resolver.write.setTextWithSig(
        [
          m.node,
          m.key,
          m.value,
          m.nonce,
          m.deadline,
          await signIntent(
            publicClient,
            aliceClient,
            'SimplexResolver',
            resolver.address,
            'SetText',
            m,
          ),
        ],
        { account: registrar },
      )
      expect(
        await resolver.read.text([node('afterfreeze'), 'simplex.contact']),
      ).toBe('https://smp/after')
    })

    it('no key can take a live name — the property the whole design rests on', async () => {
      const held = 'freshname'
      const tokenId = BigInt(labelhash(held))
      // admin cannot re-register it
      await namePolicy.write.addReservedNames([[held], TRADEMARK], { account: admin })
      await expect(
        namePolicy.write.registerReserved([held, admin.address, MIN_REGISTRATION], {
          account: admin,
        }),
      ).toBeRevertedWithoutReason()
      // nor reclaim it
      await expect(
        baseRegistrar.write.reclaim([tokenId, admin.address], {
          account: admin,
        }),
      ).toBeRevertedWithoutReason()
      expect((await baseRegistrar.read.ownerOf([tokenId])).toLowerCase()).toBe(
        buyer.address.toLowerCase(),
      )
    })
  })
})
