import hre from 'hardhat'
import {
  labelhash,
  namehash,
  zeroAddress,
  zeroHash,
  getAddress,
  keccak256,
  toHex,
} from 'viem'
import { describe, it, expect } from 'vitest'

import { DAY } from '../fixtures/constants.js'

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const [ownerClient, aliceClient, bobClient, relayerClient, carolClient] =
  await connection.viem.getWalletClients()
const ownerAccount = ownerClient.account
const aliceAccount = aliceClient.account
const bobAccount = bobClient.account
const relayer = relayerClient.account

const DURATION = 365n * DAY
const FAR_FUTURE = 4102444800n // 2100-01-01

async function fixture() {
  const ensRegistry = await connection.viem.deployContract('ENSRegistry', [])
  const baseRegistrar = await connection.viem.deployContract(
    'BaseRegistrarImplementation',
    [ensRegistry.address, namehash('simplex')],
  )
  await ensRegistry.write.setSubnodeOwner([
    zeroHash,
    labelhash('simplex'),
    baseRegistrar.address,
  ])
  await baseRegistrar.write.addController([ownerAccount.address])
  await baseRegistrar.write.registerWithLabel([
    'alicechat',
    aliceAccount.address,
    DURATION,
  ])
  return { ensRegistry, baseRegistrar }
}

const loadFixture = async () => connection.networkHelpers.loadFixture(fixture)

const TOKEN_ID = BigInt(labelhash('alicechat'))
const ALICE = getAddress(aliceAccount.address)
const BOB = getAddress(bobAccount.address)
const CAROL = getAddress(carolClient.account.address)

const types = {
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
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

type Intent = {
  from: `0x${string}`
  to: `0x${string}`
  tokenId: bigint
  nonce: bigint
  deadline: bigint
}

async function sign(
  client: typeof aliceClient,
  verifyingContract: `0x${string}`,
  primaryType: keyof typeof types,
  message: any,
) {
  const chainId = await publicClient.getChainId()
  return client.signTypedData({
    account: client.account,
    domain: { name: 'SimplexNames', version: '1', chainId, verifyingContract },
    types,
    primaryType,
    message,
  })
}

/** The holder's half, relayed: an offer of `m.tokenId` to `m.to`. */
async function offer(
  baseRegistrar: any,
  m: Intent,
  signer: typeof aliceClient = aliceClient,
  ephemeralPubKey: `0x${string}` = '0x',
  viewTag: `0x${string}` = '0x00',
) {
  const sig = await sign(signer, baseRegistrar.address, 'ApproveName', {
    ...m,
    ephemeralPubKey,
    viewTag,
  })
  return baseRegistrar.write.approveWithSig(
    [
      m.from,
      m.to,
      m.tokenId,
      m.nonce,
      m.deadline,
      sig,
      ephemeralPubKey,
      viewTag,
    ],
    { account: relayer },
  )
}

/** The recipient's half, relayed: taking `m.tokenId` from `m.from`. */
async function claim(
  baseRegistrar: any,
  m: Intent,
  signer: typeof aliceClient = bobClient,
) {
  const sig = await sign(signer, baseRegistrar.address, 'ClaimName', m)
  return baseRegistrar.write.claimWithSig(
    [m.from, m.to, m.tokenId, m.nonce, m.deadline, sig],
    { account: relayer },
  )
}

const aliceToBob: Intent = {
  from: ALICE,
  to: BOB,
  tokenId: TOKEN_ID,
  nonce: 0n,
  deadline: FAR_FUTURE,
}

// A plausible compressed secp256k1 point and its view tag. The contract treats
// these as opaque - it stores nothing and checks nothing beyond emptiness.
const EPH =
  '0x029ac20335eb38768d2052be1dbbc3c8f6178407458e51e6b4ad22f1d91758895b' as const
const VIEW_TAG = '0xe0' as const

describe('approveWithSig and claimWithSig', () => {
  it('pins the EIP-712 type hashes', async () => {
    // The client signs against these strings. A change here silently
    // invalidates every signature the app produces, so they are pinned rather
    // than derived.
    const { baseRegistrar } = await loadFixture()
    expect(await baseRegistrar.read.APPROVE_TYPEHASH()).toBe(
      keccak256(
        toHex(
          'ApproveName(address from,address to,uint256 tokenId,bytes ephemeralPubKey,bytes1 viewTag,uint256 nonce,uint256 deadline)',
        ),
      ),
    )
    expect(await baseRegistrar.read.CLAIM_TYPEHASH()).toBe(
      keccak256(
        toHex(
          'ClaimName(address from,address to,uint256 tokenId,uint256 nonce,uint256 deadline)',
        ),
      ),
    )
  })

  it('moves the name only once the recipient claims the offer', async () => {
    const { baseRegistrar, ensRegistry } = await loadFixture()
    // Submitted by the relayer, who signed nothing and pays only gas.
    await offer(baseRegistrar, aliceToBob)
    expect(await baseRegistrar.read.ownerOf([TOKEN_ID])).toBe(ALICE)
    expect(await baseRegistrar.read.getApproved([TOKEN_ID])).toBe(BOB)

    await claim(baseRegistrar, aliceToBob)
    expect(await baseRegistrar.read.ownerOf([TOKEN_ID])).toBe(BOB)
    // Auto-reclaim: the registry node follows the token, so the previous owner
    // can no longer manage the name or its subnames.
    expect(await ensRegistry.read.owner([namehash('alicechat.simplex')])).toBe(
      BOB,
    )
    expect(await baseRegistrar.read.getApproved([TOKEN_ID])).toBe(zeroAddress)
    expect(await baseRegistrar.read.nonces([ALICE])).toBe(1n)
    expect(await baseRegistrar.read.nonces([BOB])).toBe(1n)
  })

  it('announces with the offer only when an ephemeral key is supplied', async () => {
    const { baseRegistrar } = await loadFixture()
    await offer(baseRegistrar, aliceToBob, aliceClient, EPH, VIEW_TAG)
    const logs = await publicClient.getContractEvents({
      address: baseRegistrar.address,
      abi: baseRegistrar.abi,
      eventName: 'Announcement',
    })
    expect(logs.length).toBe(1)
    expect(logs[0].args.ephemeralPubKey).toBe(EPH)
    expect(logs[0].args.stealthAddress).toBe(BOB)
    expect(logs[0].args.schemeId).toBe(1n)
    expect(logs[0].args.caller).toBe(getAddress(relayer.address))
    // ERC-5564 metadata for an ERC-721: view tag, transferFrom selector, token
    // contract, token id. Pinned so the layout stays decodable by any indexer
    // that knows the standard.
    expect(logs[0].args.metadata).toBe(
      ('0x' +
        VIEW_TAG.slice(2) +
        '23b872dd' +
        baseRegistrar.address.slice(2).toLowerCase() +
        TOKEN_ID.toString(16).padStart(64, '0')) as `0x${string}`,
    )
  })

  it('announces nothing for a plain offer, or for the claim', async () => {
    const { baseRegistrar } = await loadFixture()
    await offer(baseRegistrar, aliceToBob)
    await claim(baseRegistrar, aliceToBob)
    const logs = await publicClient.getContractEvents({
      address: baseRegistrar.address,
      abi: baseRegistrar.abi,
      eventName: 'Announcement',
    })
    expect(logs.length).toBe(0)
  })

  it('rejects an offer to the holder, so announcements cost a real gift', async () => {
    const { baseRegistrar } = await loadFixture()
    await expect(
      offer(
        baseRegistrar,
        { ...aliceToBob, to: ALICE },
        aliceClient,
        EPH,
        VIEW_TAG,
      ),
    ).rejects.toThrow('TransferToSelf')
  })

  it('rejects an offer signed by anyone but the holder', async () => {
    const { baseRegistrar } = await loadFixture()
    // Bob signs an offer of Alice's name to himself.
    await expect(offer(baseRegistrar, aliceToBob, bobClient)).rejects.toThrow(
      'InvalidSignature',
    )
  })

  it('rejects a claim signed by anyone but the recipient', async () => {
    const { baseRegistrar } = await loadFixture()
    await offer(baseRegistrar, aliceToBob)
    // Alice cannot complete her own offer: the recipient has to take it.
    await expect(claim(baseRegistrar, aliceToBob, aliceClient)).rejects.toThrow(
      'InvalidSignature',
    )
  })

  it('rejects a claim with no offer', async () => {
    const { baseRegistrar } = await loadFixture()
    await expect(claim(baseRegistrar, aliceToBob)).rejects.toThrow('NotOffered')
  })

  it('rejects a claim of an offer made to someone else', async () => {
    const { baseRegistrar } = await loadFixture()
    await offer(baseRegistrar, { ...aliceToBob, to: CAROL })
    await expect(claim(baseRegistrar, aliceToBob)).rejects.toThrow('NotOffered')
  })

  it('a withdrawn offer cannot be claimed', async () => {
    const { baseRegistrar } = await loadFixture()
    await offer(baseRegistrar, aliceToBob)
    await offer(baseRegistrar, { ...aliceToBob, to: zeroAddress, nonce: 1n })
    expect(await baseRegistrar.read.getApproved([TOKEN_ID])).toBe(zeroAddress)
    await expect(claim(baseRegistrar, aliceToBob)).rejects.toThrow('NotOffered')
  })

  it('an offer dies when the name moves', async () => {
    const { baseRegistrar } = await loadFixture()
    await offer(baseRegistrar, aliceToBob)
    // Bob takes it, then offers it on to Carol, who takes it too. One nonce
    // per signer, so Bob's claim moved his counter to 1.
    await claim(baseRegistrar, aliceToBob)
    const bobToCarol = { ...aliceToBob, from: BOB, to: CAROL }
    await offer(baseRegistrar, { ...bobToCarol, nonce: 1n }, bobClient)
    await claim(baseRegistrar, bobToCarol, carolClient)
    // Alice no longer holds it, and the move cleared Bob's offer to Carol.
    await expect(
      claim(baseRegistrar, { ...aliceToBob, nonce: 2n }),
    ).rejects.toThrow('NotNameOwner')
    await expect(
      claim(baseRegistrar, { ...aliceToBob, from: CAROL, nonce: 2n }),
    ).rejects.toThrow('NotOffered')
  })

  it('rejects a replayed offer and a replayed claim', async () => {
    const { baseRegistrar } = await loadFixture()
    await offer(baseRegistrar, aliceToBob)
    await expect(offer(baseRegistrar, aliceToBob)).rejects.toThrow(
      'InvalidNonce',
    )
    await claim(baseRegistrar, aliceToBob)
    // Bob offers it back and Alice takes it; Bob's old claim must stay dead.
    const back = { ...aliceToBob, from: BOB, to: ALICE, nonce: 1n }
    await offer(baseRegistrar, back, bobClient)
    await claim(baseRegistrar, back, aliceClient)
    await offer(baseRegistrar, { ...aliceToBob, nonce: 2n })
    await expect(claim(baseRegistrar, aliceToBob)).rejects.toThrow(
      'InvalidNonce',
    )
  })

  it('rejects an expired offer and an expired claim', async () => {
    const { baseRegistrar } = await loadFixture()
    await expect(
      offer(baseRegistrar, { ...aliceToBob, deadline: 1n }),
    ).rejects.toThrow('SignatureExpired')
    await offer(baseRegistrar, aliceToBob)
    await expect(
      claim(baseRegistrar, { ...aliceToBob, deadline: 1n }),
    ).rejects.toThrow('SignatureExpired')
  })

  it('rejects an offer or a claim of an expired name', async () => {
    const { baseRegistrar } = await loadFixture()
    await offer(baseRegistrar, aliceToBob)
    // Past expiry, ownerOf reverts - a lapsed name must not move out from under
    // whoever is about to re-register it.
    await connection.networkHelpers.time.increase(DURATION + 1n)
    await expect(
      offer(baseRegistrar, { ...aliceToBob, nonce: 1n }),
    ).rejects.toThrow()
    await expect(claim(baseRegistrar, aliceToBob)).rejects.toThrow()
  })
})
