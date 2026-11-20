import type { ContractAbis } from '@nomicfoundation/hardhat-viem/types'
import hre from 'hardhat'
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  labelhash,
  namehash,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
  zeroHash,
} from 'viem'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { dnsEncodeName } from '../fixtures/dnsEncodeName.js'
import {
  acceptGeneralTermsForClaim,
  AMPLE_ALLOWANCE,
  commitUnderGeneralTerms,
  deployBehindProxy,
  deployNamesV2,
  FAR_FUTURE,
  implementationOf,
  type InitializeParameters,
  MIN_REGISTRATION,
  node,
  proxyAdminOf,
  Reason,
  registerWithCredit,
  registration,
  signIntent,
  signRegistration,
  storageLayout,
  type StorageMember,
  TLD,
  TLD_NODE,
  YEAR,
  YEAR_PRICE_USD,
} from './fixtures/namesV2.js'

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const testClient = await connection.viem.getTestClient()
const [
  deployerClient,
  adminClient,
  guardianClient,
  registrarClient,
  aliceClient,
  bobClient,
] = await connection.viem.getWalletClients()
const deployer = deployerClient.account
const admin = adminClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const alice = aliceClient.account
const bob = bobClient.account
type Account = typeof admin

const NAME = 'alicename'
const TOKEN = BigInt(labelhash(NAME))
const SUB = namehash(`work.${NAME}.${TLD}`)
const KEY = 'simplex.contact'
const CONFIG = {
  tldNode: TLD_NODE,
  tldSuffix: `.${TLD}`,
  minCharLength: 6,
  smpxNft: zeroAddress,
  nftGateEnabled: false,
}
const ALREADY_INITIALIZED = 'Initializable: contract is already initialized'
const UUPS_SELECTORS = [
  'upgradeTo(address)',
  'upgradeToAndCall(address,bytes)',
  'proxiableUUID()',
].map((signature) => toFunctionSelector(signature))

async function fixture() {
  const f = await deployNamesV2(connection, {
    owner: admin.address,
    beneficiary: guardian.address,
  })
  const renderer = await connection.viem.deployContract('MetadataRenderer', [
    `.${TLD}`,
  ])
  await f.baseRegistrar.write.setMetadataRenderer([renderer.address])
  await f.sponsor.write.setRegistrarAllowance(
    [registrar.address, AMPLE_ALLOWANCE],
    { account: guardian },
  )
  await f.controller.write.setPublicSalesOpen([true], { account: admin })
  const reg = registration(NAME, alice.address, {
    resolver: f.resolver.address,
  })
  await commitUnderGeneralTerms(connection, f.controller, reg, {
    account: alice,
  })
  await registerWithCredit(connection, f.sponsor, reg, { account: registrar })
  await f.resolver.write.setText([node(NAME), KEY, 'https://smp/alice'], {
    account: alice,
  })
  await f.ens.write.setApprovalForAll([f.subnameRegistrar.address, true], {
    account: alice,
  })
  await f.subnameRegistrar.write.createSubname([node(NAME), 'work'], {
    account: alice,
  })
  await f.namePolicy.write.addReservedNames([['brandname'], Reason.Trademark], {
    account: admin,
  })
  await f.namePolicy.write.addCommunityNames([['community']], {
    account: admin,
  })
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)
type Fixture = Awaited<ReturnType<typeof fixture>>

const stack = (f: Fixture) => [
  {
    name: 'ENSRegistry',
    contract: f.ens,
    deployImplementation: () =>
      connection.viem.deployContract('ENSRegistry', []),
    owner: () => f.ens.read.owner([zeroHash]),
    state: () =>
      Promise.all([
        f.ens.read.owner([TLD_NODE]),
        f.ens.read.owner([node(NAME)]),
        f.ens.read.resolver([node(NAME)]),
        f.ens.read.owner([SUB]),
        f.ens.read.isTld([TLD_NODE]),
        f.ens.read.isApprovedForAll([
          alice.address,
          f.subnameRegistrar.address,
        ]),
      ]),
    authorizedCall: async () => {
      await f.ens.write.setSubnodeOwner(
        [zeroHash, labelhash('eth'), admin.address],
        { account: admin },
      )
      return f.ens.read.owner([namehash('eth')])
    },
    authorizedResult: getAddress(admin.address),
  },
  {
    name: 'BaseRegistrarImplementation',
    contract: f.baseRegistrar,
    deployImplementation: () =>
      connection.viem.deployContract('BaseRegistrarImplementation', [
        f.ens.address,
        TLD_NODE,
      ]),
    owner: () => f.baseRegistrar.read.owner(),
    state: () =>
      Promise.all([
        f.baseRegistrar.read.owner(),
        f.baseRegistrar.read.ownerOf([TOKEN]),
        f.baseRegistrar.read.nameExpires([TOKEN]),
        f.baseRegistrar.read.labelOf([TOKEN]),
        f.baseRegistrar.read.controllers([f.controller.address]),
        f.baseRegistrar.read.namePolicy(),
        f.baseRegistrar.read.subnameHook(),
        f.baseRegistrar.read.totalSupply(),
        f.baseRegistrar.read.tokenURI([TOKEN]),
      ]),
    authorizedCall: async () => {
      await f.baseRegistrar.write.setMaxLabelLength([63n], { account: admin })
      return f.baseRegistrar.read.maxLabelLength()
    },
    authorizedResult: 63n,
  },
  {
    name: 'SimplexResolver',
    contract: f.resolver,
    deployImplementation: () =>
      connection.viem.deployContract('SimplexResolver', [
        f.ens.address,
        f.subnameRegistrar.address,
        f.controller.address,
        zeroAddress,
      ]),
    state: () =>
      Promise.all([
        f.resolver.read.text([node(NAME), KEY]),
        f.resolver.read.recordVersions([node(NAME)]),
        f.resolver.read.relayedSigner([SUB]),
      ]),
    authorizedCall: async () => {
      await f.resolver.write.setText(
        [node(NAME), 'simplex.channel', 'https://smp/channel'],
        { account: alice },
      )
      return f.resolver.read.text([node(NAME), 'simplex.channel'])
    },
    authorizedResult: 'https://smp/channel',
  },
  {
    name: 'SubnameRegistrar',
    contract: f.subnameRegistrar,
    deployImplementation: () =>
      connection.viem.deployContract('SubnameRegistrar', [
        f.ens.address,
        f.baseRegistrar.address,
      ]),
    state: () =>
      Promise.all([
        f.subnameRegistrar.read.resolver(),
        f.subnameRegistrar.read.ownerOf([BigInt(SUB)]),
        f.subnameRegistrar.read.parentOf([SUB]),
        f.subnameRegistrar.read.expiryOf([node(NAME)]),
        f.subnameRegistrar.read.childrenLength([node(NAME)]),
        f.subnameRegistrar.read.labelOf([labelhash('work')]),
      ]),
    authorizedCall: async () => {
      await f.namePolicy.write.addReservedNames(
        [['adminname'], Reason.Trademark],
        { account: admin },
      )
      await f.namePolicy.write.registerReserved(
        ['adminname', admin.address, MIN_REGISTRATION],
        { account: admin },
      )
      await f.ens.write.setApprovalForAll([f.subnameRegistrar.address, true], {
        account: admin,
      })
      await f.subnameRegistrar.write.createSubname([node('adminname'), 'ops'], {
        account: admin,
      })
      return f.subnameRegistrar.read.ownerOf([
        BigInt(namehash(`ops.adminname.${TLD}`)),
      ])
    },
    authorizedResult: getAddress(admin.address),
  },
  {
    name: 'SimplexController',
    contract: f.controller,
    deployImplementation: () =>
      connection.viem.deployContract('SimplexController', []),
    owner: () => f.controller.read.owner(),
    state: () =>
      Promise.all([
        f.controller.read.owner(),
        f.controller.read.beneficiary(),
        f.controller.read.sponsor(),
        f.controller.read.namePolicy(),
        f.controller.read.defaultResolver(),
        f.controller.read.publicSalesOpen(),
        f.controller.read.prices(),
        f.controller.read.minCharLength(),
        f.controller.read.tldNode(),
        f.controller.read.tldSuffix(),
        f.controller.read.wasDefaultResolver([f.resolver.address]),
      ]),
    authorizedCall: async () => {
      await f.controller.write.setMinCharLength([5], { account: admin })
      return f.controller.read.minCharLength()
    },
    authorizedResult: 5,
  },
  {
    name: 'SimplexNamePolicy',
    contract: f.namePolicy,
    deployImplementation: () =>
      connection.viem.deployContract('SimplexNamePolicy', [
        f.controller.address,
        f.baseRegistrar.address,
      ]),
    owner: () => f.controller.read.owner(),
    state: () =>
      Promise.all([
        f.namePolicy.read.reservedNames([labelhash('brandname')]),
        f.namePolicy.read.isReserved([labelhash('brandname')]),
        f.namePolicy.read.communityNames([labelhash('community')]),
        f.namePolicy.read.generalTermsHash(),
        f.namePolicy.read.generalTermsLink(),
        f.namePolicy.read.communityTermsHash(),
        f.namePolicy.read.communityTermsLink(),
      ]),
    authorizedCall: async () => {
      await f.namePolicy.write.addReservedNames(
        [['adminbrand'], Reason.Trademark],
        { account: admin },
      )
      return f.namePolicy.read.reservedNames([labelhash('adminbrand')])
    },
    authorizedResult: Reason.Trademark,
  },
  {
    name: 'SimplexSponsor',
    contract: f.sponsor,
    deployImplementation: () =>
      connection.viem.deployContract('SimplexSponsor', [f.controller.address]),
    state: () =>
      Promise.all([
        f.sponsor.read.controller(),
        f.sponsor.read.registrarAllowance([registrar.address]),
        f.sponsor.read.nonces([alice.address]),
      ]),
    authorizedCall: async () => {
      await f.sponsor.write.setRegistrarAllowance(
        [bob.address, YEAR_PRICE_USD],
        { account: guardian },
      )
      return f.sponsor.read.registrarAllowance([bob.address])
    },
    authorizedResult: YEAR_PRICE_USD,
  },
  {
    name: 'UniversalResolver',
    contract: f.universalResolver,
    deployImplementation: () =>
      connection.viem.deployContract('UniversalResolver', [
        deployer.address,
        f.ens.address,
        f.gatewayProvider.address,
      ]),
    state: () =>
      Promise.all([
        f.universalResolver.read.registry(),
        f.universalResolver.read.batchGatewayProvider(),
        resolveText(f, `${NAME}.${TLD}`, KEY),
      ]),
    authorizedCall: () => resolveText(f, `${NAME}.${TLD}`, KEY),
    authorizedResult: 'https://smp/alice',
  },
]
type Proxied = ReturnType<typeof stack>[number]

async function resolveText(f: Fixture, name: string, key: string) {
  const [result] = await f.universalResolver.read.resolve([
    dnsEncodeName(name),
    encodeFunctionData({
      abi: f.resolver.abi,
      functionName: 'text',
      args: [namehash(name), key],
    }),
  ])
  return decodeFunctionResult({
    abi: f.resolver.abi,
    functionName: 'text',
    data: result,
  })
}

const declares = (p: Proxied, functionName: string) =>
  p.contract.abi.some(
    (item: any) => item.type === 'function' && item.name === functionName,
  )

async function expectUpgraded(p: Proxied, account: Account) {
  const next = await p.deployImplementation()
  const proxyAdmin = await proxyAdminOf(connection, p.contract.address)
  await proxyAdmin.write.upgradeAndCall(
    [p.contract.address, next.address, '0x'],
    { account },
  )
  expect(await implementationOf(connection, p.contract.address), p.name).toBe(
    getAddress(next.address),
  )
}

async function expectUpgradeRefused(p: Proxied, account: Account) {
  const implementation = await implementationOf(connection, p.contract.address)
  const next = await p.deployImplementation()
  const proxyAdmin = await proxyAdminOf(connection, p.contract.address)
  await expect(
    proxyAdmin.write.upgradeAndCall([p.contract.address, next.address, '0x'], {
      account,
    }),
  ).toBeRevertedWithCustomError('OwnableUnauthorizedAccount')
  expect(await implementationOf(connection, p.contract.address), p.name).toBe(
    implementation,
  )
}

async function expectUpgradeToAndCallRefused(p: Proxied, account: Account) {
  const implementation = await implementationOf(connection, p.contract.address)
  const next = await p.deployImplementation()
  const proxy = await connection.viem.getContractAt(
    'ITransparentUpgradeableProxy',
    p.contract.address,
  )
  await expect(
    proxy.write.upgradeToAndCall([next.address, '0x'], { account }),
  ).toBeRevertedWithoutReason()
  expect(await implementationOf(connection, p.contract.address), p.name).toBe(
    implementation,
  )
}

async function expectInitializeRefused(
  f: Fixture,
  registry: Fixture['ens'],
  registrar: Fixture['baseRegistrar'],
  controller: Fixture['controller'],
) {
  await expect(
    registry.write.initialize([alice.address], { account: alice }),
  ).toBeRevertedWithString(ALREADY_INITIALIZED)
  await expect(
    registrar.write.initialize([f.ens.address, TLD_NODE, alice.address], {
      account: alice,
    }),
  ).toBeRevertedWithString(ALREADY_INITIALIZED)
  await expect(
    controller.write.initialize(
      [
        f.baseRegistrar.address,
        f.priceOracle.address,
        60n,
        86400n,
        f.ens.address,
        CONFIG,
        alice.address,
      ],
      { account: alice },
    ),
  ).toBeRevertedWithString(ALREADY_INITIALIZED)
}

async function gasOfCalls(f: Fixture) {
  const gasUsed = async (hash: Promise<`0x${string}`>) =>
    (await publicClient.getTransactionReceipt({ hash: await hash })).gasUsed

  const paid = registration('paidname', bob.address)
  await commitUnderGeneralTerms(connection, f.controller, paid, {
    account: bob,
  })
  const register = await gasUsed(
    f.controller.write.register([paid], {
      account: bob,
      value: 2n * YEAR_PRICE_USD,
    }),
  )

  const credited = registration('creditname', bob.address, {
    resolver: f.resolver.address,
  })
  await commitUnderGeneralTerms(connection, f.controller, credited, {
    account: bob,
  })
  const registerWithCredit = await gasUsed(
    f.sponsor.write.registerWithCredit(
      await signRegistration(connection, f.sponsor, credited),
      { account: registrar },
    ),
  )

  const text = {
    node: node('creditname'),
    key: KEY,
    value: 'https://smp/bob',
    nonce: 0n,
    deadline: FAR_FUTURE,
  }
  const setTextWithSigOnName = await gasUsed(
    f.resolver.write.setTextWithSig(
      [
        text.node,
        text.key,
        text.value,
        text.nonce,
        text.deadline,
        await signIntent(
          publicClient,
          bobClient,
          'SimplexResolver',
          f.resolver.address,
          'SetText',
          text,
        ),
      ],
      { account: registrar },
    ),
  )

  await f.ens.write.setApprovalForAll([f.subnameRegistrar.address, true], {
    account: bob,
  })
  const create = {
    parentNode: node('creditname'),
    label: 'team',
    nonce: 0n,
    deadline: FAR_FUTURE,
  }
  const createSubnameWithSig = await gasUsed(
    f.subnameRegistrar.write.createSubnameWithSig(
      [
        create.parentNode,
        create.label,
        create.nonce,
        create.deadline,
        await signIntent(
          publicClient,
          bobClient,
          'SimplexSubnames',
          f.subnameRegistrar.address,
          'CreateSubname',
          create,
        ),
      ],
      { account: registrar },
    ),
  )

  const subText = {
    node: namehash(`team.creditname.${TLD}`),
    key: KEY,
    value: 'https://smp/team',
    nonce: 1n,
    deadline: FAR_FUTURE,
  }
  const setTextWithSigOnSubname = await gasUsed(
    f.resolver.write.setTextWithSig(
      [
        subText.node,
        subText.key,
        subText.value,
        subText.nonce,
        subText.deadline,
        await signIntent(
          publicClient,
          bobClient,
          'SimplexResolver',
          f.resolver.address,
          'SetText',
          subText,
        ),
      ],
      { account: registrar },
    ),
  )

  return {
    register,
    registerWithCredit,
    setTextWithSigOnName,
    createSubnameWithSig,
    setTextWithSigOnSubname,
  }
}

describe('upgradeable stack', () => {
  describe('initialize', () => {
    it("sets the registry's root owner, the registrar's ens, baseNode and owner, and the controller's configuration and owner", async () => {
      const { priceOracle } = await load()
      const { contract: registry } = await deployBehindProxy(
        connection,
        'ENSRegistry',
        [],
        admin.address,
        [alice.address],
      )
      expect(await registry.read.owner([zeroHash])).toBe(
        getAddress(alice.address),
      )

      const { contract: baseRegistrar } = await deployBehindProxy(
        connection,
        'BaseRegistrarImplementation',
        [registry.address, TLD_NODE],
        admin.address,
        [registry.address, TLD_NODE, alice.address],
      )
      expect(
        await Promise.all([
          baseRegistrar.read.ens(),
          baseRegistrar.read.baseNode(),
          baseRegistrar.read.owner(),
        ]),
      ).toEqual([
        getAddress(registry.address),
        TLD_NODE,
        getAddress(alice.address),
      ])

      const { contract: controller } = await deployBehindProxy(
        connection,
        'SimplexController',
        [],
        admin.address,
        [
          baseRegistrar.address,
          priceOracle.address,
          60n,
          86400n,
          registry.address,
          CONFIG,
          alice.address,
        ],
      )
      expect(
        await Promise.all([
          controller.read.ens(),
          controller.read.prices(),
          controller.read.minCommitmentAge(),
          controller.read.maxCommitmentAge(),
          controller.read.tldNode(),
          controller.read.tldSuffix(),
          controller.read.minCharLength(),
          controller.read.smpxNft(),
          controller.read.nftGateEnabled(),
          controller.read.rentPriceUSD([NAME, YEAR]),
          controller.read.owner(),
        ]),
      ).toEqual([
        getAddress(registry.address),
        getAddress(priceOracle.address),
        60n,
        86400n,
        TLD_NODE,
        `.${TLD}`,
        6,
        zeroAddress,
        false,
        { base: YEAR_PRICE_USD, premium: 0n },
        getAddress(alice.address),
      ])
    })

    it('a second initialize reverts', async () => {
      const f = await load()
      const proxies = stack(f).filter((p) => declares(p, 'initialize'))
      expect(proxies.map((p) => p.name)).toEqual([
        'ENSRegistry',
        'BaseRegistrarImplementation',
        'SimplexController',
      ])
      await expectInitializeRefused(f, f.ens, f.baseRegistrar, f.controller)
    })

    it('initialize on the implementation reverts', async () => {
      const f = await load()
      const implementation = async <ContractName extends keyof ContractAbis>(
        name: ContractName,
        proxy: `0x${string}`,
      ) =>
        connection.viem.getContractAt(
          name,
          await implementationOf(connection, proxy),
        )
      await expectInitializeRefused(
        f,
        await implementation('ENSRegistry', f.ens.address),
        await implementation(
          'BaseRegistrarImplementation',
          f.baseRegistrar.address,
        ),
        await implementation('SimplexController', f.controller.address),
      )
    })

    it('deployBehindProxy requires initialize arguments exactly where the ABI declares initialize', () => {
      expectTypeOf<InitializeParameters<'ENSRegistry'>>().toEqualTypeOf<
        [[`0x${string}`]]
      >()
      expectTypeOf<
        InitializeParameters<'BaseRegistrarImplementation'>
      >().toEqualTypeOf<[[`0x${string}`, `0x${string}`, `0x${string}`]]>()
      expectTypeOf<
        InitializeParameters<'SimplexController'>
      >().not.toEqualTypeOf<[]>()
      expectTypeOf<InitializeParameters<'SimplexResolver'>>().toEqualTypeOf<[]>()
      expectTypeOf<InitializeParameters<'SubnameRegistrar'>>().toEqualTypeOf<[]>()
      expectTypeOf<InitializeParameters<'SimplexNamePolicy'>>().toEqualTypeOf<
        []
      >()
      expectTypeOf<InitializeParameters<'SimplexSponsor'>>().toEqualTypeOf<[]>()
      expectTypeOf<InitializeParameters<'UniversalResolver'>>().toEqualTypeOf<
        []
      >()
    })
  })

  describe('the eight proxies', () => {
    it('upgradeAndCall by the ProxyAdmin owner succeeds; by any other caller it reverts', async () => {
      for (const p of stack(await load())) {
        for (const account of [deployer, guardian, alice]) {
          await expectUpgradeRefused(p, account)
        }
        await expectUpgraded(p, admin)
      }
    }, 120000)

    it('upgradeToAndCall sent to a proxy by the ProxyAdmin owner reverts, and the implementation stays', async () => {
      for (const p of stack(await load())) {
        await expectUpgradeToAndCallRefused(p, admin)
      }
    })

    it('upgradeToAndCall sent to a proxy by the contract owner reverts, and the implementation stays', async () => {
      const f = await load()
      await f.controller.write.transferOwnership([deployer.address], {
        account: admin,
      })
      await f.controller.write.acceptOwnership({ account: deployer })
      const owned = stack(f).filter((p) => p.owner)
      expect(owned.map((p) => p.name)).toEqual([
        'ENSRegistry',
        'BaseRegistrarImplementation',
        'SimplexController',
        'SimplexNamePolicy',
      ])
      for (const p of owned) {
        expect(await p.owner!(), p.name).toBe(getAddress(deployer.address))
        await expectUpgradeToAndCallRefused(p, deployer)
      }
    })

    it('an owner, holder, beneficiary or public call through each proxy succeeds', async () => {
      const f = await load()
      await f.baseRegistrar.write.transferOwnership([admin.address])
      await f.ens.write.setOwner([zeroHash, admin.address])
      for (const p of stack(f)) {
        expect(await p.authorizedCall(), p.name).toEqual(p.authorizedResult)
      }
    })

    it('an upgrade with empty data leaves state unchanged', async () => {
      for (const p of stack(await load())) {
        const before = await p.state()
        await expectUpgraded(p, admin)
        expect(await p.state(), p.name).toEqual(before)
      }
    })

    it('a resolver multicall or multicallWithNodeCheck of upgradeToAndCall as upgrade data installs the nested implementation', async () => {
      for (const functionName of ['multicall', 'multicallWithNodeCheck']) {
        const f = await load()
        const resolverEntry = stack(f).find(
          (p) => p.name === 'SimplexResolver',
        )!
        const candidate = await resolverEntry.deployImplementation()
        const nested = await resolverEntry.deployImplementation()
        const entries = [
          encodeFunctionData({
            abi: parseAbi([
              'function upgradeToAndCall(address newImplementation, bytes data)',
            ]),
            functionName: 'upgradeToAndCall',
            args: [nested.address, '0x'],
          }),
        ]
        const proxyAdmin = await proxyAdminOf(connection, f.resolver.address)
        await proxyAdmin.write.upgradeAndCall(
          [
            f.resolver.address,
            candidate.address,
            functionName === 'multicall'
              ? encodeFunctionData({
                  abi: f.resolver.abi,
                  functionName: 'multicall',
                  args: [entries],
                })
              : encodeFunctionData({
                  abi: f.resolver.abi,
                  functionName: 'multicallWithNodeCheck',
                  args: [zeroHash, entries],
                }),
          ],
          { account: admin },
        )
        expect(
          await implementationOf(connection, f.resolver.address),
          functionName,
        ).toBe(getAddress(nested.address))
      }
    })

    it('DOMAIN_SEPARATOR reads the same after an upgrade', async () => {
      const f = await load()
      const proxies = stack(f).filter((p) => declares(p, 'DOMAIN_SEPARATOR'))
      expect(proxies.map((p) => p.name)).toEqual([
        'ENSRegistry',
        'BaseRegistrarImplementation',
        'SimplexResolver',
        'SubnameRegistrar',
        'SimplexNamePolicy',
        'SimplexSponsor',
      ])
      const separators = () =>
        Promise.all([
          f.ens.read.DOMAIN_SEPARATOR(),
          f.baseRegistrar.read.DOMAIN_SEPARATOR(),
          f.resolver.read.DOMAIN_SEPARATOR(),
          f.subnameRegistrar.read.DOMAIN_SEPARATOR(),
          f.namePolicy.read.DOMAIN_SEPARATOR(),
          f.sponsor.read.DOMAIN_SEPARATOR(),
        ])
      const before = await separators()
      for (const p of proxies) {
        await expectUpgraded(p, admin)
      }
      expect(await separators()).toEqual(before)
    })

    it('the ABIs of the eight implementations exclude the UUPS selectors', async () => {
      for (const p of stack(await load())) {
        const selectors = p.contract.abi
          .filter((item: any) => item.type === 'function')
          .map((item: any) => toFunctionSelector(item))
        expect(
          selectors.filter((selector) => UUPS_SELECTORS.includes(selector)),
          p.name,
        ).toEqual([])
      }
    })

    it('after renounceOwnership on one ProxyAdmin, its proxy upgrade reverts and the other seven upgrade', async () => {
      for (const { name } of stack(await load())) {
        const proxies = stack(await load())
        const frozen = proxies.find((p) => p.name === name)!
        const proxyAdmin = await proxyAdminOf(
          connection,
          frozen.contract.address,
        )
        await proxyAdmin.write.renounceOwnership({ account: admin })
        await expectUpgradeRefused(frozen, admin)
        for (const p of proxies.filter((p) => p !== frozen)) {
          await expectUpgraded(p, admin)
        }
      }
    }, 120000)

    it('after transferOwnership on one ProxyAdmin, its proxy is upgraded by the new owner only, and the other seven by the admin Safe only', async () => {
      for (const { name } of stack(await load())) {
        const proxies = stack(await load())
        const moved = proxies.find((p) => p.name === name)!
        const proxyAdmin = await proxyAdminOf(
          connection,
          moved.contract.address,
        )
        await proxyAdmin.write.transferOwnership([bob.address], {
          account: admin,
        })
        await expectUpgradeRefused(moved, admin)
        await expectUpgraded(moved, bob)
        for (const p of proxies.filter((p) => p !== moved)) {
          await expectUpgradeRefused(p, bob)
          await expectUpgraded(p, admin)
        }
      }
    }, 120000)

    it('the storage layouts of the eight implementations match their snapshot', async () => {
      const lines = (members: StorageMember[], indent = ''): string[] =>
        members.flatMap(
          ({ slot, offset, numberOfBytes, label, type, members }) => [
            `${indent}${slot}:${offset}+${numberOfBytes} ${label} ${type}`,
            ...lines(members, `${indent}  `),
          ],
        )
      const layouts: Record<string, string[]> = {}
      for (const { name } of stack(await load())) {
        layouts[name] = lines(
          (await storageLayout(hre.artifacts, name)).map(
            ({ contract, label, ...variable }) => ({
              ...variable,
              label: `${contract}.${label}`,
            }),
          ),
        )
      }
      await expect(
        `${JSON.stringify(layouts, null, 2)}\n`,
      ).toMatchFileSnapshot('./__snapshots__/storageLayouts.json')
    })
  })

  describe('the registrar through its proxy', () => {
    it('has the name and symbol of a direct deployment', async () => {
      const { ens, baseRegistrar } = await load()
      const direct = await connection.viem.deployContract(
        'BaseRegistrarImplementation',
        [ens.address, TLD_NODE],
      )
      for (const deployment of [baseRegistrar, direct]) {
        expect(await deployment.read.name()).toBe('SimpleX Names')
        expect(await deployment.read.symbol()).toBe('SIMPLEX')
      }
    })

    it('registers, transfers and renders a name', async () => {
      const { ens, baseRegistrar } = await load()
      expect(await baseRegistrar.read.ownerOf([TOKEN])).toBe(
        getAddress(alice.address),
      )
      expect(await baseRegistrar.read.labelOf([TOKEN])).toBe(NAME)
      expect(await ens.read.owner([node(NAME)])).toBe(
        getAddress(alice.address),
      )

      await baseRegistrar.write.approve([bob.address, TOKEN], {
        account: alice,
      })
      await acceptGeneralTermsForClaim(
        connection,
        baseRegistrar,
        TOKEN,
        alice.address,
        { account: bob },
      )
      await baseRegistrar.write.transferFrom(
        [alice.address, bob.address, TOKEN],
        { account: bob },
      )
      expect(await baseRegistrar.read.ownerOf([TOKEN])).toBe(
        getAddress(bob.address),
      )
      expect(await ens.read.owner([node(NAME)])).toBe(getAddress(bob.address))

      const uri = await baseRegistrar.read.tokenURI([TOKEN])
      const json = JSON.parse(
        Buffer.from(uri.split(',')[1], 'base64').toString(),
      )
      expect(json.name).toBe(`${NAME}.${TLD}`)
    })
  })

  it('gas of five calls through the proxies and on direct deployments', async () => {
    const throughProxies = await gasOfCalls(await load())
    const f = await load()
    for (const p of stack(f)) {
      await testClient.setCode({
        address: p.contract.address,
        bytecode: (await publicClient.getCode({
          address: await implementationOf(connection, p.contract.address),
        }))!,
      })
    }
    const direct = await gasOfCalls(f)
    const calls = Object.keys(throughProxies) as (keyof typeof direct)[]
    console.table(
      Object.fromEntries(
        calls.map((call) => [
          call,
          {
            proxies: Number(throughProxies[call]),
            direct: Number(direct[call]),
            added: Number(throughProxies[call] - direct[call]),
          },
        ]),
      ),
    )
    for (const call of calls) {
      expect(throughProxies[call], call).toBeGreaterThan(direct[call])
    }
  }, 120000)
})
