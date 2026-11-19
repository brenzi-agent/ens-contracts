import hre from 'hardhat'
import {
  getAddress,
  labelhash,
  namehash,
  toFunctionSelector,
  zeroAddress,
  zeroHash,
} from 'viem'
import { describe, expect, it } from 'vitest'

import {
  acceptGeneralTermsForClaim,
  AMPLE_ALLOWANCE,
  commitUnderGeneralTerms,
  deployBehindProxy,
  deployNamesV2,
  FAR_FUTURE,
  implementationOf,
  MIN_REGISTRATION,
  node,
  proxyAdminOf,
  Reason,
  registerWithCredit,
  registration,
  signIntent,
  signRegistration,
  storageLayout,
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
    constructorArgs: [],
    initializeArgs: [alice.address],
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
    callByAdmin: async () => {
      await f.ens.write.setSubnodeOwner(
        [namehash('eth'), labelhash('data'), admin.address],
        { account: admin },
      )
      return f.ens.read.owner([namehash('data.eth')])
    },
    calledByAdmin: getAddress(admin.address),
  },
  {
    name: 'BaseRegistrarImplementation',
    contract: f.baseRegistrar,
    constructorArgs: [f.ens.address, TLD_NODE],
    initializeArgs: [f.ens.address, TLD_NODE, alice.address],
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
    callByAdmin: async () => {
      await f.baseRegistrar.write.setMaxLabelLength([63n], { account: admin })
      return f.baseRegistrar.read.maxLabelLength()
    },
    calledByAdmin: 63n,
  },
  {
    name: 'SimplexResolver',
    contract: f.resolver,
    constructorArgs: [
      f.ens.address,
      f.subnameRegistrar.address,
      f.controller.address,
      zeroAddress,
    ],
    state: () =>
      Promise.all([
        f.resolver.read.text([node(NAME), KEY]),
        f.resolver.read.recordVersions([node(NAME)]),
        f.resolver.read.relayedSigner([SUB]),
      ]),
    callByAdmin: async () => {
      await f.resolver.write.setText(
        [namehash('eth'), KEY, 'https://smp/admin'],
        { account: admin },
      )
      return f.resolver.read.text([namehash('eth'), KEY])
    },
    calledByAdmin: 'https://smp/admin',
  },
  {
    name: 'SubnameRegistrar',
    contract: f.subnameRegistrar,
    constructorArgs: [f.ens.address, f.baseRegistrar.address],
    state: () =>
      Promise.all([
        f.subnameRegistrar.read.resolver(),
        f.subnameRegistrar.read.ownerOf([BigInt(SUB)]),
        f.subnameRegistrar.read.parentOf([SUB]),
        f.subnameRegistrar.read.expiryOf([node(NAME)]),
        f.subnameRegistrar.read.childrenLength([node(NAME)]),
        f.subnameRegistrar.read.labelOf([labelhash('work')]),
      ]),
    callByAdmin: async () => {
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
    calledByAdmin: getAddress(admin.address),
  },
  {
    name: 'SimplexController',
    contract: f.controller,
    constructorArgs: [],
    initializeArgs: [
      f.baseRegistrar.address,
      f.priceOracle.address,
      60n,
      86400n,
      f.ens.address,
      CONFIG,
      alice.address,
    ],
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
    callByAdmin: async () => {
      await f.controller.write.setMinCharLength([5], { account: admin })
      return f.controller.read.minCharLength()
    },
    calledByAdmin: 5,
  },
  {
    name: 'SimplexNamePolicy',
    contract: f.namePolicy,
    constructorArgs: [f.controller.address, f.baseRegistrar.address],
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
    callByAdmin: async () => {
      await f.namePolicy.write.addReservedNames(
        [['adminbrand'], Reason.Trademark],
        { account: admin },
      )
      return f.namePolicy.read.reservedNames([labelhash('adminbrand')])
    },
    calledByAdmin: Reason.Trademark,
  },
]
type Proxied = ReturnType<typeof stack>[number]

const declares = (p: Proxied, functionName: string) =>
  p.contract.abi.some(
    (item: any) => item.type === 'function' && item.name === functionName,
  )

const nextImplementation = (p: Proxied) =>
  connection.viem.deployContract(p.name, p.constructorArgs)

async function expectUpgraded(p: Proxied, account: Account) {
  const next = await nextImplementation(p)
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
  const next = await nextImplementation(p)
  const proxyAdmin = await proxyAdminOf(connection, p.contract.address)
  await expect(
    proxyAdmin.write.upgradeAndCall([p.contract.address, next.address, '0x'], {
      account,
    }),
    p.name,
  ).toBeRevertedWithCustomError('OwnableUnauthorizedAccount')
  expect(await implementationOf(connection, p.contract.address), p.name).toBe(
    implementation,
  )
}

async function expectUpgradeToAndCallRefused(p: Proxied, account: Account) {
  const implementation = await implementationOf(connection, p.contract.address)
  const next = await nextImplementation(p)
  const proxy = await connection.viem.getContractAt(
    'ITransparentUpgradeableProxy',
    p.contract.address,
  )
  await expect(
    proxy.write.upgradeToAndCall([next.address, '0x'], { account }),
    p.name,
  ).toBeRevertedWithoutReason()
  expect(await implementationOf(connection, p.contract.address), p.name).toBe(
    implementation,
  )
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
      const proxies = stack(await load()).filter((p) =>
        declares(p, 'initialize'),
      )
      expect(proxies.map((p) => p.name)).toEqual([
        'ENSRegistry',
        'BaseRegistrarImplementation',
        'SimplexController',
      ])
      for (const p of proxies) {
        await expect(
          p.contract.write.initialize(p.initializeArgs, { account: alice }),
          p.name,
        ).toBeRevertedWithString(ALREADY_INITIALIZED)
      }
    })

    it('initialize on the implementation reverts', async () => {
      for (const p of stack(await load()).filter((p) =>
        declares(p, 'initialize'),
      )) {
        const implementation = await connection.viem.getContractAt(
          p.name,
          await implementationOf(connection, p.contract.address),
        )
        await expect(
          implementation.write.initialize(p.initializeArgs, { account: alice }),
          p.name,
        ).toBeRevertedWithString(ALREADY_INITIALIZED)
      }
    })
  })

  describe('the six proxies', () => {
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

    it('an owner call sent through each proxy by the admin Safe succeeds', async () => {
      const f = await load()
      await f.baseRegistrar.write.transferOwnership([admin.address])
      await f.ens.write.setSubnodeOwner([
        zeroHash,
        labelhash('eth'),
        admin.address,
      ])
      for (const p of stack(f)) {
        expect(await p.callByAdmin(), p.name).toEqual(p.calledByAdmin)
      }
    })

    it('state written before an upgrade reads the same after it', async () => {
      for (const p of stack(await load())) {
        const before = await p.state()
        await expectUpgraded(p, admin)
        expect(await p.state(), p.name).toEqual(before)
      }
    })

    it('DOMAIN_SEPARATOR reads the same after an upgrade', async () => {
      const proxies = stack(await load()).filter((p) =>
        declares(p, 'DOMAIN_SEPARATOR'),
      )
      expect(proxies.map((p) => p.name)).toEqual([
        'ENSRegistry',
        'BaseRegistrarImplementation',
        'SimplexResolver',
        'SubnameRegistrar',
        'SimplexNamePolicy',
      ])
      for (const p of proxies) {
        const before = await p.contract.read.DOMAIN_SEPARATOR()
        await expectUpgraded(p, admin)
        expect(await p.contract.read.DOMAIN_SEPARATOR(), p.name).toBe(before)
      }
    })

    it('the ABIs of the six implementations exclude the UUPS selectors', async () => {
      for (const p of stack(await load())) {
        const selectors = p.contract.abi
          .filter((item: any) => item.type === 'function')
          .map((item: any) => toFunctionSelector(item))
        expect(
          selectors.filter((selector: string) =>
            UUPS_SELECTORS.includes(selector),
          ),
          p.name,
        ).toEqual([])
      }
    })

    it('after renounceOwnership on one ProxyAdmin, its proxy upgrade reverts and the other five upgrade', async () => {
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

    it('after transferOwnership on one ProxyAdmin, its proxy is upgraded by the new owner only, and the other five by the admin Safe only', async () => {
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

    it('the storage layouts of the six implementations match their snapshot', async () => {
      const layouts: Record<string, string[]> = {}
      for (const { name } of stack(await load())) {
        layouts[name] = (await storageLayout(hre.artifacts, name)).map(
          ({ slot, offset, label, type }) =>
            `${slot}:${offset} ${label} ${type}`,
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
