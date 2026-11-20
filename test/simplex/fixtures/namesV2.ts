import type {
  ConstructorArgs,
  ContractAbis,
} from '@nomicfoundation/hardhat-viem/types'
import type { ArtifactManager } from 'hardhat/types/artifacts'
import type { NetworkConnection } from 'hardhat/types/network'
import { readFile } from 'node:fs/promises'
import {
  type Abi,
  type ContractFunctionArgs,
  type ContractFunctionName,
  encodeFunctionData,
  getAddress,
  keccak256,
  labelhash,
  namehash,
  slice,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'

import { DAY } from '../../fixtures/constants.js'

export const YEAR = 365n * DAY

/** The shortest a name can be registered for; renewal still takes a year. */
export const MIN_REGISTRATION = 2n * YEAR

/** US cents per year for a given yearly price in whole dollars. */
const perYear = (usd: bigint) => usd * 100n

/** The oracle stores cents; `priceUSD` quotes attoUSD. */
export const ATTO_PER_CENT = 10n ** 16n

/** What a length with no exception costs: $10 a year. */
export const PRICE_BASE = perYear(10n)

/** Ten times the base for each character below six, in exact multiples. */
export const PRICE_EXCEPTIONS = [
  { labelLength: 1n, priceCentsPerYear: PRICE_BASE * 100000n },
  { labelLength: 2n, priceCentsPerYear: PRICE_BASE * 10000n },
  { labelLength: 3n, priceCentsPerYear: PRICE_BASE * 1000n },
  { labelLength: 4n, priceCentsPerYear: PRICE_BASE * 100n },
  { labelLength: 5n, priceCentsPerYear: PRICE_BASE * 10n },
] as const

/** The yearly price of a label of `len` characters, in attoUSD. */
export function yearPriceUSD(len: number, years = 1n) {
  const exception = PRICE_EXCEPTIONS.find(
    ({ labelLength }) => BigInt(len) === labelLength,
  )
  return (
    (exception ? exception.priceCentsPerYear : PRICE_BASE) *
    ATTO_PER_CENT *
    years
  )
}

/** What a one-year 6+ character name costs, in attoUSD. */
export const YEAR_PRICE_USD = yearPriceUSD(6)


export const TLD = 'simplex'
export const TLD_NODE = namehash(TLD)

export const termsLink = (path: string, digit: string) =>
  `https://git.simplex.chat/simplex-chat/simplex-chat/raw/commit/${digit.repeat(40)}/${path}#sha256=${digit.repeat(64)}`

export const GENERAL_TERMS_LINK = termsLink('general-terms.md', '1')
export const GENERAL_TERMS = keccak256(toHex(GENERAL_TERMS_LINK))
export const COMMUNITY_TERMS_LINK = termsLink('community-terms.md', '2')
export const COMMUNITY_TERMS = keccak256(toHex(COMMUNITY_TERMS_LINK))

const erc1967Slot = (name: string) =>
  toHex(BigInt(keccak256(toHex(`eip1967.proxy.${name}`))) - 1n, { size: 32 })

async function addressInSlot(
  connection: NetworkConnection,
  proxy: `0x${string}`,
  slot: `0x${string}`,
) {
  const publicClient = await connection.viem.getPublicClient()
  const word = await publicClient.getStorageAt({ address: proxy, slot })
  return getAddress(slice(word!, 12))
}

export const implementationOf = (
  connection: NetworkConnection,
  proxy: `0x${string}`,
) => addressInSlot(connection, proxy, erc1967Slot('implementation'))

export async function proxyAdminOf(
  connection: NetworkConnection,
  proxy: `0x${string}`,
) {
  return connection.viem.getContractAt(
    'ProxyAdmin',
    await addressInSlot(connection, proxy, erc1967Slot('admin')),
  )
}

type Initialize<ContractName extends keyof ContractAbis> = Extract<
  ContractFunctionName<ContractAbis[ContractName], 'nonpayable'>,
  'initialize'
>

export type InitializeParameters<ContractName extends keyof ContractAbis> = [
  Initialize<ContractName>,
] extends [never]
  ? []
  : [
      initializeArgs: ContractFunctionArgs<
        ContractAbis[ContractName],
        'nonpayable',
        Initialize<ContractName>
      >,
    ]

export async function deployBehindProxy<
  ContractName extends keyof ContractAbis,
>(
  connection: NetworkConnection,
  contractName: ContractName,
  constructorArgs: ConstructorArgs<ContractName>,
  initialOwner: `0x${string}`,
  ...initialize: NoInfer<InitializeParameters<ContractName>>
) {
  const [initializeArgs] = initialize as [] | [readonly unknown[]]
  const implementation = await connection.viem.deployContract(
    contractName,
    constructorArgs,
  )
  const proxy = await connection.viem.deployContract(
    'TransparentUpgradeableProxy',
    [
      implementation.address,
      initialOwner,
      initializeArgs
        ? encodeFunctionData({
            abi: implementation.abi as Abi,
            functionName: 'initialize',
            args: initializeArgs,
          })
        : '0x',
    ],
  )
  return {
    contract: await connection.viem.getContractAt(contractName, proxy.address),
    implementation,
    proxyAdmin: await proxyAdminOf(connection, proxy.address),
  }
}

export type StorageMember = {
  label: string
  slot: bigint
  offset: number
  numberOfBytes: bigint
  type: string
  members: StorageMember[]
}

export type StorageVariable = StorageMember & { contract: string }

export async function storageLayout(
  artifacts: ArtifactManager,
  contractName: string,
): Promise<StorageVariable[]> {
  const artifact = await artifacts.readArtifact(contractName)
  const outputPath = await artifacts.getBuildInfoOutputPath(
    artifact.buildInfoId!,
  )
  const { output } = JSON.parse(await readFile(outputPath!, 'utf8'))
  const { storage, types } =
    output.contracts[artifact.inputSourceName!][contractName].storageLayout
  const definitions = (node: any, nodeType: string): any[] =>
    node?.nodeType === nodeType
      ? [node]
      : typeof node === 'object' && node !== null
        ? Object.values(node).flatMap((child) => definitions(child, nodeType))
        : []
  const enumValues = new Map(
    definitions(output.sources, 'EnumDefinition').map((definition) => [
      definition.canonicalName,
      definition.members.map((member: any) => member.name).join(','),
    ]),
  )
  const declaringContracts = new Map<number, string>(
    definitions(output.sources, 'ContractDefinition').flatMap((definition) =>
      definition.nodes
        .filter((node: any) => node.nodeType === 'VariableDeclaration')
        .map((node: any) => [node.id, definition.name]),
    ),
  )
  const declaringContract = (astId: number) => {
    const name = declaringContracts.get(astId)
    if (name === undefined)
      throw new Error(`${contractName}: no contract declares variable ${astId}`)
    return name
  }
  const typeLabel = (type: string): string =>
    types[type].label.replace(
      /enum ([\w.]+)/g,
      (label: string, name: string) => {
        const values = enumValues.get(name)
        if (values === undefined)
          throw new Error(`${contractName}: no definition of enum ${name}`)
        return `${label} {${values}}`
      },
    )
  const membersOf = (type: string): any[] => {
    const { members, value, base } = types[type]
    if (members) return members
    if (value) return membersOf(value)
    if (base) return membersOf(base)
    return []
  }
  const member = (entry: any): StorageMember => ({
    label: entry.label,
    slot: BigInt(entry.slot),
    offset: entry.offset,
    numberOfBytes: BigInt(types[entry.type].numberOfBytes),
    type: typeLabel(entry.type),
    members: membersOf(entry.type).map(member),
  })
  return storage.map(
    (entry: any): StorageVariable => ({
      ...member(entry),
      contract: declaringContract(entry.astId),
    }),
  )
}

/**
 * The full `.simplex` stack, wired as in `deploy-mainnet.mjs`:
 * SimplexResolver in place of PublicResolver, the SubnameRegistrar in the
 * resolver's wrapper slot, the controller proxy as both trusted controller and
 * credit granter, and no reverse registrar.
 *
 * `owner` owns the controller and the eight `ProxyAdmin`s. `beneficiary` is the
 * guardian key. `registrar` stands in for the names service hot wallet and
 * starts with no credits.
 */
export async function deployNamesV2(
  connection: NetworkConnection,
  accounts: {
    owner: `0x${string}`
    beneficiary: `0x${string}`
  },
) {
  const viem = connection.viem
  const [deployer] = await viem.getWalletClients()
  const { contract: ens } = await deployBehindProxy(
    connection,
    'ENSRegistry',
    [],
    accounts.owner,
    [deployer.account.address],
  )
  const { contract: baseRegistrar } = await deployBehindProxy(
    connection,
    'BaseRegistrarImplementation',
    [ens.address, TLD_NODE],
    accounts.owner,
    [ens.address, TLD_NODE, deployer.account.address],
  )
  await ens.write.setSubnodeOwner([zeroHash, labelhash(TLD), baseRegistrar.address])

  // $10/yr at 6+ characters, ten times more for each character lost. With the
  // feed pinned to 1e8 below, 1 attoUSD is 1 wei, so a one-year 6-character name
  // costs 10 ETH in these tests. No premium: an expired name is priced at plain
  // rent, as `StablePriceOracle` did before.
  const dummyOracle = await viem.deployContract('DummyOracle', [100000000n])
  const priceOracle = await viem.deployContract('SimplexPriceOracle', [
    dummyOracle.address,
    8, // feed decimals: DummyOracle mimics Chainlink's 8
    PRICE_BASE,
    PRICE_EXCEPTIONS,
  ])

  const { contract: controller, implementation } = await deployBehindProxy(
    connection,
    'SimplexController',
    [],
    accounts.owner,
    [
      baseRegistrar.address,
      priceOracle.address,
      1n, // minCommitmentAge: must be non-zero; 1s means a separate block suffices
      86400n,
      ens.address,
      {
        tldNode: TLD_NODE,
        tldSuffix: `.${TLD}`,
        minCharLength: 6,
        smpxNft: zeroAddress,
        nftGateEnabled: false,
      },
      accounts.owner,
    ],
  )

  const { contract: subnameRegistrar } = await deployBehindProxy(
    connection,
    'SubnameRegistrar',
    [ens.address, baseRegistrar.address],
    accounts.owner,
  )
  const { contract: resolver } = await deployBehindProxy(
    connection,
    'SimplexResolver',
    [
      ens.address,
      subnameRegistrar.address, // wrapper slot: subname authorisation routes here
      controller.address, // trustedETHController
      zeroAddress, // trustedReverseRegistrar: unused, and inert at address(0)
    ],
    accounts.owner,
  )
  await subnameRegistrar.write.setResolver([resolver.address])

  await baseRegistrar.write.addController([controller.address])
  await baseRegistrar.write.setSubnameHook([subnameRegistrar.address])
  await controller.write.setDefaultResolver([resolver.address], {
    account: accounts.owner,
  })
  await controller.write.setBeneficiary([accounts.beneficiary], {
    account: accounts.owner,
  })

  const { contract: sponsor } = await deployBehindProxy(
    connection,
    'SimplexSponsor',
    [controller.address],
    accounts.owner,
  )
  await controller.write.setSponsor([sponsor.address], {
    account: accounts.owner,
  })

  const { namePolicy, namePolicyImplementation } = await deployNamePolicy(
    connection,
    controller,
    baseRegistrar,
    accounts.owner,
  )

  const gatewayProvider = await viem.deployContract('DummyGatewayProvider', [])
  const { contract: universalResolver } = await deployBehindProxy(
    connection,
    'UniversalResolver',
    [deployer.account.address, ens.address, gatewayProvider.address],
    accounts.owner,
  )

  return {
    ens,
    baseRegistrar,
    controller,
    sponsor,
    namePolicy,
    namePolicyImplementation,
    implementation,
    resolver,
    subnameRegistrar,
    universalResolver,
    gatewayProvider,
    priceOracle,
    dummyOracle,
  }
}

export async function deployNamePolicy(
  connection: NetworkConnection,
  controller: any,
  baseRegistrar: any,
  owner: `0x${string}`,
) {
  const { contract: namePolicy, implementation: namePolicyImplementation } =
    await deployBehindProxy(
      connection,
      'SimplexNamePolicy',
      [controller.address, baseRegistrar.address],
      owner,
    )
  await baseRegistrar.write.addController([namePolicy.address])
  await controller.write.setNamePolicy([namePolicy.address], {
    account: owner,
  })
  await namePolicy.write.setGeneralTerms([GENERAL_TERMS_LINK], { account: owner })
  await namePolicy.write.setCommunityTerms([COMMUNITY_TERMS_LINK], {
    account: owner,
  })
  await baseRegistrar.write.setNamePolicy([namePolicy.address])
  return { namePolicy, namePolicyImplementation }
}

/** A registration struct with the defaults every test here wants. */
export function registration(
  label: string,
  owner: `0x${string}`,
  overrides: Partial<{
    duration: bigint
    resolver: `0x${string}`
    data: `0x${string}`[]
  }> = {},
) {
  return {
    label,
    owner,
    duration: overrides.duration ?? MIN_REGISTRATION,
    secret: zeroHash,
    resolver: overrides.resolver ?? zeroAddress,
    data: overrides.data ?? [],
    reverseRecord: 0,
    referrer: zeroHash,
  } as const
}

export function node(label: string) {
  return namehash(`${label}.${TLD}`)
}

/** EIP-712 type definitions for every signed intent in the names-v2 stack. */
export const eip712Types = {
  SetText: [
    { name: 'node', type: 'bytes32' },
    { name: 'key', type: 'string' },
    { name: 'value', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  ClearRecords: [
    { name: 'node', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  ApproveAll: [
    { name: 'owner', type: 'address' },
    { name: 'operator', type: 'address' },
    { name: 'approved', type: 'bool' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  CreateSubname: [
    { name: 'parentNode', type: 'bytes32' },
    { name: 'label', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  ApproveName: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'ephemeralPubKey', type: 'bytes' },
    { name: 'viewTag', type: 'bytes1' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  ClaimName: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'offer', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  RegisterName: [
    { name: 'label', type: 'string' },
    { name: 'owner', type: 'address' },
    { name: 'duration', type: 'uint256' },
    { name: 'resolver', type: 'address' },
    { name: 'data', type: 'bytes[]' },
    { name: 'disputeDays', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  DeleteSubname: [
    { name: 'parentNode', type: 'bytes32' },
    { name: 'label', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  AcceptGeneralTerms: [
    { name: 'commitment', type: 'bytes32' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  AcceptGeneralTermsForClaim: [
    { name: 'tokenId', type: 'uint256' },
    { name: 'from', type: 'address' },
    { name: 'offer', type: 'uint256' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  AcceptCommunityTerms: [
    { name: 'commitment', type: 'bytes32' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  AcceptCommunityTermsForClaim: [
    { name: 'tokenId', type: 'uint256' },
    { name: 'from', type: 'address' },
    { name: 'offer', type: 'uint256' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export const FAR_FUTURE = 4102444800n

export const MIN_DISPUTE_DAYS = 14n

export const passDisputePeriod = (connection: NetworkConnection) =>
  connection.networkHelpers.time.increase(MIN_DISPUTE_DAYS * DAY)

/** Sign one of the intents above against `verifyingContract`. */
export async function signIntent(
  publicClient: any,
  client: any,
  domainName:
    | 'SimplexResolver'
    | 'SimplexENSRegistry'
    | 'SimplexSubnames'
    | 'SimplexNames'
    | 'SimplexSponsor'
    | 'SimplexNamePolicy',
  verifyingContract: `0x${string}`,
  primaryType: keyof typeof eip712Types,
  message: Record<string, unknown>,
) {
  const chainId = await publicClient.getChainId()
  return client.signTypedData({
    account: client.account,
    domain: { name: domainName, version: '1', chainId, verifyingContract },
    types: eip712Types,
    primaryType,
    message,
  })
}

/** The `SimplexSponsor` set on `controller`. */
export async function sponsorOf(
  connection: NetworkConnection,
  controller: any,
) {
  return connection.viem.getContractAt(
    'SimplexSponsor',
    await controller.read.sponsor(),
  )
}

/**
 * `registerWithCredit` arguments for `reg`, with a `RegisterName` signature by
 * `signer`, or by the owner's wallet client when no signer is given.
 */
export async function signRegistration<
  R extends {
    label: string
    owner: `0x${string}`
    duration: bigint
    resolver: `0x${string}`
    data: readonly `0x${string}`[]
  },
>(
  connection: NetworkConnection,
  sponsor: any,
  reg: R,
  {
    signer,
    deadline = FAR_FUTURE,
    disputeDays = MIN_DISPUTE_DAYS,
  }: { signer?: any; deadline?: bigint; disputeDays?: bigint } = {},
): Promise<[R, bigint, bigint, bigint, `0x${string}`]> {
  const client =
    signer ??
    (await connection.viem.getWalletClients()).find(
      (c) => c.account.address.toLowerCase() === reg.owner.toLowerCase(),
    )
  if (!client) throw new Error(`no wallet client for ${reg.owner}`)
  const nonce: bigint = await sponsor.read.nonces([reg.owner])
  const sig = await signIntent(
    await connection.viem.getPublicClient(),
    client,
    'SimplexSponsor',
    sponsor.address,
    'RegisterName',
    {
      label: reg.label,
      owner: reg.owner,
      duration: reg.duration,
      resolver: reg.resolver,
      data: reg.data,
      disputeDays,
      nonce,
      deadline,
    },
  )
  return [reg, disputeDays, nonce, deadline, sig]
}

/** `sponsor.registerWithCredit` for `reg`, signed by its owner. */
export async function registerWithCredit(
  connection: NetworkConnection,
  sponsor: any,
  reg: Parameters<typeof signRegistration>[2],
  options: { account: any },
) {
  return sponsor.write.registerWithCredit(
    await signRegistration(connection, sponsor, reg),
    options,
  )
}

export async function commitUnderGeneralTerms(
  connection: NetworkConnection,
  controller: any,
  reg: any,
  options: { account: any },
) {
  const namePolicy = await connection.viem.getContractAt(
    'SimplexNamePolicy',
    await controller.read.namePolicy(),
  )
  return namePolicy.write.commitUnderGeneralTerms(
    [await controller.read.makeCommitment([reg]), GENERAL_TERMS],
    options,
  )
}

export async function signGeneralTermsAcceptance(
  connection: NetworkConnection,
  controller: any,
  reg: any,
  { signer }: { signer?: any } = {},
): Promise<
  [`0x${string}`, `0x${string}`, `0x${string}`, bigint, bigint, `0x${string}`]
> {
  const namePolicy = await connection.viem.getContractAt(
    'SimplexNamePolicy',
    await controller.read.namePolicy(),
  )
  const client =
    signer ??
    (await connection.viem.getWalletClients()).find(
      (c) => c.account.address.toLowerCase() === reg.owner.toLowerCase(),
    )
  if (!client) throw new Error(`no wallet client for ${reg.owner}`)
  const commitment = await controller.read.makeCommitment([reg])
  const nonce: bigint = await namePolicy.read.nonces([reg.owner])
  const sig = await signIntent(
    await connection.viem.getPublicClient(),
    client,
    'SimplexNamePolicy',
    namePolicy.address,
    'AcceptGeneralTerms',
    { commitment, termsHash: GENERAL_TERMS, nonce, deadline: FAR_FUTURE },
  )
  return [commitment, GENERAL_TERMS, reg.owner, nonce, FAR_FUTURE, sig]
}

export async function acceptGeneralTermsForClaim(
  connection: NetworkConnection,
  baseRegistrar: any,
  tokenId: bigint,
  from: `0x${string}`,
  options: { account: any },
) {
  const namePolicy = await connection.viem.getContractAt(
    'SimplexNamePolicy',
    await baseRegistrar.read.namePolicy(),
  )
  return namePolicy.write.acceptGeneralTermsForClaim(
    [tokenId, from, await baseRegistrar.read.offers([tokenId]), GENERAL_TERMS],
    options,
  )
}

/** Enough allowance that a test never has to think about it: $1000. */
export const AMPLE_ALLOWANCE = 1000n * 10n ** 18n

/** SimplexNamePolicy.Reason. Append-only on chain: these numbers are storage. */
export const Reason = {
  None: 0,
  Internal: 1,
  Trademark: 2,
  Community: 3,
} as const
