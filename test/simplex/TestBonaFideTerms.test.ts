import hre from 'hardhat'
import {
  getAddress,
  keccak256,
  labelhash,
  parseEventLogs,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'
import { describe, expect, it } from 'vitest'

import {
  AMPLE_ALLOWANCE,
  deployNamesV2,
  FAR_FUTURE,
  MIN_REGISTRATION,
  registration,
  signIntent,
  signRegistration,
  YEAR_PRICE_USD,
} from './fixtures/namesV2.js'
import { DAY } from '../fixtures/constants.js'

const TRADEMARK = 2 // SimplexNamePolicy.Reason.Trademark
const GRACE_PERIOD = 90n * DAY
const TERMS = keccak256(toHex('bona fide community terms v1'))
const NEW_TERMS = keccak256(toHex('bona fide community terms v2'))
const COMMUNITY_ID = BigInt(labelhash('community'))

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const [
  ownerClient,
  guardianClient,
  registrarClient,
  aliceClient,
  bobClient,
  malloryClient,
] = await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const alice = aliceClient.account
const bob = bobClient.account
const mallory = malloryClient.account

async function fixture() {
  const f = await deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
  await f.sponsor.write.setRegistrarAllowance(
    [registrar.address, AMPLE_ALLOWANCE],
    {
      account: guardian,
    },
  )
  await f.controller.write.setPublicSalesOpen([true], { account: owner })
  await f.namePolicy.write.setTerms([TERMS, 'ipfs://terms'], { account: owner })
  await f.namePolicy.write.addBonaFideNames([['community']], {
    account: guardian,
  })
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)
type Fixture = Awaited<ReturnType<typeof fixture>>

const communityFor = (holder: `0x${string}`) =>
  registration('community', holder)

const register = (controller: any, reg: ReturnType<typeof registration>) =>
  controller.write.register([reg], {
    account: alice,
    value: 2n * YEAR_PRICE_USD,
  })

async function acceptAndRegister({ controller, namePolicy }: Fixture) {
  const reg = communityFor(alice.address)
  await namePolicy.write.commitUnderBonaFideCommunityTerms(
    [await controller.read.makeCommitment([reg]), TERMS],
    { account: alice },
  )
  return register(controller, reg)
}

async function acceptanceEvents(namePolicy: any, hash: `0x${string}`) {
  return parseEventLogs({
    abi: namePolicy.abi,
    eventName: 'BonaFideTermsAccepted',
    logs: (await publicClient.waitForTransactionReceipt({ hash })).logs,
  }).map(({ args }) => [args.name, args.holder, args.termsHash])
}

const signAcceptance = async (
  namePolicy: any,
  signer: any,
  commitment: `0x${string}`,
) =>
  signIntent(
    publicClient,
    signer,
    'SimplexNamePolicy',
    namePolicy.address,
    'AcceptBonaFideTerms',
    {
      commitment,
      termsHash: TERMS,
      nonce: await namePolicy.read.nonces([signer.account.address]),
      deadline: FAR_FUTURE,
    },
  )

async function offerToBob({ baseRegistrar }: Fixture) {
  await baseRegistrar.write.approve([bob.address, COMMUNITY_ID], {
    account: alice,
  })
  return baseRegistrar.read.offers([COMMUNITY_ID])
}

describe('bona fide community names', () => {
  describe('listing', () => {
    it('the guardian lists a free name, and only the owner removes it', async () => {
      const { namePolicy } = await load()
      await expect(
        namePolicy.write.addBonaFideNames([['other']], { account: alice }),
      ).toBeRevertedWithCustomError('NotOwnerOrBeneficiary')
      await namePolicy.write.addBonaFideNames([['other']], {
        account: guardian,
      })
      expect(await namePolicy.read.bonaFideNames([labelhash('other')])).toBe(
        true,
      )

      await expect(
        namePolicy.write.removeBonaFideNames([['other']], {
          account: guardian,
        }),
      ).toBeRevertedWithCustomError('NotOwner')
      await namePolicy.write.removeBonaFideNames([['other']], {
        account: owner,
      })
      expect(await namePolicy.read.bonaFideNames([labelhash('other')])).toBe(
        false,
      )
    })

    it('skips a name that is registered or in its grace period, and lists it once free', async () => {
      const { controller, namePolicy } = await load()
      const reg = registration('heldname', alice.address)
      await controller.write.commit(
        [await controller.read.makeCommitment([reg])],
        {
          account: alice,
        },
      )
      await register(controller, reg)

      const list = () =>
        namePolicy.write.addBonaFideNames([['heldname']], { account: guardian })
      await expect(list())
        .toEmitEvent('BonaFideNameSkipped')
        .withArgs({ name: 'heldname' })
      await connection.networkHelpers.time.increase(MIN_REGISTRATION + 1n)
      await expect(list())
        .toEmitEvent('BonaFideNameSkipped')
        .withArgs({ name: 'heldname' })
      expect(await namePolicy.read.bonaFideNames([labelhash('heldname')])).toBe(
        false,
      )

      await connection.networkHelpers.time.increase(GRACE_PERIOD)
      await expect(list())
        .toEmitEvent('BonaFideNameAdded')
        .withArgs({ name: 'heldname' })
      expect(await namePolicy.read.bonaFideNames([labelhash('heldname')])).toBe(
        true,
      )
    })

    it('pins the EIP-712 type hashes', async () => {
      const { namePolicy } = await load()
      expect(await namePolicy.read.ACCEPT_TYPEHASH()).toBe(
        keccak256(
          toHex(
            'AcceptBonaFideTerms(bytes32 commitment,bytes32 termsHash,uint256 nonce,uint256 deadline)',
          ),
        ),
      )
      expect(await namePolicy.read.ACCEPT_FOR_CLAIM_TYPEHASH()).toBe(
        keccak256(
          toHex(
            'AcceptBonaFideTermsForClaim(uint256 tokenId,address from,uint256 offer,bytes32 termsHash,uint256 nonce,uint256 deadline)',
          ),
        ),
      )
    })

    it('both setters revert for a contract bound to another controller or registrar', async () => {
      const { controller, baseRegistrar, implementation } = await load()
      const boundElsewhere = await connection.viem.deployContract(
        'SimplexNamePolicy',
        [implementation.address, mallory.address],
      )
      await expect(
        controller.write.setNamePolicy([boundElsewhere.address], {
          account: owner,
        }),
      ).toBeRevertedWithCustomError('NamePolicyMismatch')
      await expect(
        baseRegistrar.write.setNamePolicy([boundElsewhere.address], {
          account: owner,
        }),
      ).toBeRevertedWithCustomError('NamePolicyMismatch')
    })

    it('only the owner sets the terms, never to zero, and the event records the hash and URI', async () => {
      const { namePolicy } = await load()
      await expect(
        namePolicy.write.setTerms([NEW_TERMS, ''], { account: guardian }),
      ).toBeRevertedWithCustomError('NotOwner')
      await expect(
        namePolicy.write.setTerms([zeroHash, ''], { account: owner }),
      ).toBeRevertedWithCustomError('ZeroTerms')
      await expect(
        namePolicy.write.setTerms([NEW_TERMS, 'ipfs://terms-v2'], {
          account: owner,
        }),
      )
        .toEmitEvent('TermsSet')
        .withArgs({ termsHash: NEW_TERMS, termsURI: 'ipfs://terms-v2' })
    })
  })

  describe('registration', () => {
    it('a listed name cannot be registered without accepting the terms, on either path', async () => {
      const { controller, sponsor, namePolicy } = await load()
      const reg = communityFor(alice.address)
      await controller.write.commit(
        [await controller.read.makeCommitment([reg])],
        {
          account: alice,
        },
      )
      await expect(register(controller, reg)).toBeRevertedWithCustomErrorFrom(
        namePolicy,
        'TermsNotAccepted',
      )
      await expect(
        sponsor.write.registerWithCredit(
          await signRegistration(connection, sponsor, reg),
          {
            account: registrar,
          },
        ),
      ).toBeRevertedWithCustomErrorFrom(namePolicy, 'TermsNotAccepted')
    })

    it('accepting at commit registers it, and the event records the name, holder and terms', async () => {
      const f = await load()
      const hash = await acceptAndRegister(f)
      expect(await f.baseRegistrar.read.ownerOf([COMMUNITY_ID])).toBe(
        getAddress(alice.address),
      )
      expect(await acceptanceEvents(f.namePolicy, hash)).toEqual([
        ['community', getAddress(alice.address), TERMS],
      ])
      const commitment = await f.controller.read.makeCommitment([
        communityFor(alice.address),
      ])
      expect(
        await f.namePolicy.read.acceptedTerms([commitment, alice.address]),
      ).toBe(zeroHash)
    })

    it('a listed name cannot be accepted or registered before terms are set', async () => {
      const { controller, namePolicyImplementation } = await load()
      const proxy = await connection.viem.deployContract(
        'SimplexNamePolicyProxy',
        [namePolicyImplementation.address, '0x'],
      )
      const unset = await connection.viem.getContractAt(
        'SimplexNamePolicy',
        proxy.address,
      )
      await unset.write.addBonaFideNames([['community']], { account: guardian })
      await controller.write.setNamePolicy([unset.address], {
        account: owner,
      })
      const reg = communityFor(alice.address)
      const commitment = await controller.read.makeCommitment([reg])
      await expect(
        unset.write.commitUnderBonaFideCommunityTerms([commitment, zeroHash], {
          account: alice,
        }),
      ).toBeRevertedWithCustomError('TermsMismatch')
      await controller.write.commit([commitment], { account: alice })
      await expect(register(controller, reg)).toBeRevertedWithCustomErrorFrom(
        unset,
        'TermsNotAccepted',
      )
    })

    it('the registrar relays a signed acceptance and registers on credit', async () => {
      const { controller, sponsor, namePolicy, baseRegistrar } = await load()
      const reg = communityFor(bob.address)
      const commitment = await controller.read.makeCommitment([reg])
      await namePolicy.write.commitUnderBonaFideCommunityTermsWithSig(
        [
          commitment,
          TERMS,
          bob.address,
          0n,
          FAR_FUTURE,
          await signAcceptance(namePolicy, bobClient, commitment),
        ],
        { account: registrar },
      )
      const hash = await sponsor.write.registerWithCredit(
        await signRegistration(connection, sponsor, reg),
        { account: registrar },
      )
      expect(await baseRegistrar.read.ownerOf([COMMUNITY_ID])).toBe(
        getAddress(bob.address),
      )
      expect(await acceptanceEvents(namePolicy, hash)).toEqual([
        ['community', getAddress(bob.address), TERMS],
      ])
    })

    it("someone else's acceptance neither counts nor blocks the owner's", async () => {
      const { controller, namePolicy, baseRegistrar } = await load()
      const reg = communityFor(alice.address)
      const commitment = await controller.read.makeCommitment([reg])
      await namePolicy.write.commitUnderBonaFideCommunityTerms(
        [commitment, TERMS],
        {
          account: mallory,
        },
      )
      await expect(register(controller, reg)).toBeRevertedWithCustomErrorFrom(
        namePolicy,
        'TermsNotAccepted',
      )
      await namePolicy.write.commitUnderBonaFideCommunityTerms(
        [commitment, TERMS],
        {
          account: alice,
        },
      )
      await register(controller, reg)
      expect(await baseRegistrar.read.ownerOf([COMMUNITY_ID])).toBe(
        getAddress(alice.address),
      )
    })

    it('new terms between commit and reveal require a new acceptance', async () => {
      const { controller, namePolicy } = await load()
      const reg = communityFor(alice.address)
      const commitment = await controller.read.makeCommitment([reg])
      await namePolicy.write.commitUnderBonaFideCommunityTerms(
        [commitment, TERMS],
        {
          account: alice,
        },
      )
      await namePolicy.write.setTerms([NEW_TERMS, 'ipfs://terms-v2'], {
        account: owner,
      })
      await expect(register(controller, reg)).toBeRevertedWithCustomErrorFrom(
        namePolicy,
        'TermsNotAccepted',
      )
      await expect(
        namePolicy.write.commitUnderBonaFideCommunityTerms(
          [commitment, TERMS],
          {
            account: alice,
          },
        ),
      ).toBeRevertedWithCustomError('TermsMismatch')
      await namePolicy.write.commitUnderBonaFideCommunityTerms(
        [commitment, NEW_TERMS],
        {
          account: alice,
        },
      )
      await register(controller, reg)
    })

    it('a signed acceptance reverts from the wrong signer, on replay and after its deadline', async () => {
      const { controller, namePolicy } = await load()
      const commitment = await controller.read.makeCommitment([
        communityFor(bob.address),
      ])
      const relay = (deadline: bigint, sig: `0x${string}`) =>
        namePolicy.write.commitUnderBonaFideCommunityTermsWithSig(
          [commitment, TERMS, bob.address, 0n, deadline, sig],
          { account: registrar },
        )
      await expect(
        relay(
          FAR_FUTURE,
          await signAcceptance(namePolicy, malloryClient, commitment),
        ),
      ).toBeRevertedWithCustomError('InvalidSignature')
      await expect(relay(1n, '0x')).toBeRevertedWithCustomError(
        'SignatureExpired',
      )
      const sig = await signAcceptance(namePolicy, bobClient, commitment)
      await relay(FAR_FUTURE, sig)
      await expect(relay(FAR_FUTURE, sig)).toBeRevertedWithCustomError(
        'InvalidNonce',
      )
    })

    it('an unlisted name, and a name removed from the list, registers without acceptance', async () => {
      const { controller, namePolicy, baseRegistrar } = await load()
      const plain = registration('plainname', alice.address)
      await controller.write.commit(
        [await controller.read.makeCommitment([plain])],
        {
          account: alice,
        },
      )
      await register(controller, plain)

      await namePolicy.write.removeBonaFideNames([['community']], {
        account: owner,
      })
      const reg = communityFor(alice.address)
      await controller.write.commit(
        [await controller.read.makeCommitment([reg])],
        {
          account: alice,
        },
      )
      await register(controller, reg)
      expect(await baseRegistrar.read.ownerOf([COMMUNITY_ID])).toBe(
        getAddress(alice.address),
      )
    })

    it('only the controller consumes a registration acceptance', async () => {
      const { namePolicy } = await load()
      await expect(
        namePolicy.write.consumeRegistration(
          ['community', labelhash('community'), zeroHash, alice.address],
          {
            account: alice,
          },
        ),
      ).toBeRevertedWithCustomError('NotController')
    })
  })

  describe('transfer', () => {
    it('a listed name cannot be claimed without the recipient accepting, on any path', async () => {
      const f = await load()
      await acceptAndRegister(f)
      const offer = await offerToBob(f)
      const take = [alice.address, bob.address, COMMUNITY_ID] as const
      await expect(
        f.baseRegistrar.write.transferFrom(take, { account: bob }),
      ).toBeRevertedWithCustomErrorFrom(f.namePolicy, 'TermsNotAccepted')
      await expect(
        f.baseRegistrar.write.safeTransferFrom(take, { account: bob }),
      ).toBeRevertedWithCustomErrorFrom(f.namePolicy, 'TermsNotAccepted')
      const claimSig = await signIntent(
        publicClient,
        bobClient,
        'SimplexNames',
        f.baseRegistrar.address,
        'ClaimName',
        {
          from: alice.address,
          to: bob.address,
          tokenId: COMMUNITY_ID,
          offer,
          nonce: 0n,
          deadline: FAR_FUTURE,
        },
      )
      await expect(
        f.baseRegistrar.write.claimWithSig(
          [
            alice.address,
            bob.address,
            COMMUNITY_ID,
            offer,
            0n,
            FAR_FUTURE,
            claimSig,
          ],
          { account: registrar },
        ),
      ).toBeRevertedWithCustomErrorFrom(f.namePolicy, 'TermsNotAccepted')
    })

    it('the recipient accepts for the offer and claims, and the event records the recipient', async () => {
      const f = await load()
      await acceptAndRegister(f)
      const offer = await offerToBob(f)
      await f.namePolicy.write.acceptBonaFideCommunityTermsForClaim(
        [COMMUNITY_ID, alice.address, offer, TERMS],
        {
          account: bob,
        },
      )
      const hash = await f.baseRegistrar.write.transferFrom(
        [alice.address, bob.address, COMMUNITY_ID],
        { account: bob },
      )
      expect(await f.baseRegistrar.read.ownerOf([COMMUNITY_ID])).toBe(
        getAddress(bob.address),
      )
      expect(await acceptanceEvents(f.namePolicy, hash)).toEqual([
        ['community', getAddress(bob.address), TERMS],
      ])
    })

    it('the registrar relays both the acceptance and the claim', async () => {
      const f = await load()
      await acceptAndRegister(f)
      const offer = await offerToBob(f)
      const acceptSig = await signIntent(
        publicClient,
        bobClient,
        'SimplexNamePolicy',
        f.namePolicy.address,
        'AcceptBonaFideTermsForClaim',
        {
          tokenId: COMMUNITY_ID,
          from: alice.address,
          offer,
          termsHash: TERMS,
          nonce: 0n,
          deadline: FAR_FUTURE,
        },
      )
      await f.namePolicy.write.acceptBonaFideCommunityTermsForClaimWithSig(
        [
          COMMUNITY_ID,
          alice.address,
          offer,
          TERMS,
          bob.address,
          0n,
          FAR_FUTURE,
          acceptSig,
        ],
        { account: registrar },
      )
      const claimSig = await signIntent(
        publicClient,
        bobClient,
        'SimplexNames',
        f.baseRegistrar.address,
        'ClaimName',
        {
          from: alice.address,
          to: bob.address,
          tokenId: COMMUNITY_ID,
          offer,
          nonce: 0n,
          deadline: FAR_FUTURE,
        },
      )
      const hash = await f.baseRegistrar.write.claimWithSig(
        [
          alice.address,
          bob.address,
          COMMUNITY_ID,
          offer,
          0n,
          FAR_FUTURE,
          claimSig,
        ],
        { account: registrar },
      )
      expect(await f.baseRegistrar.read.ownerOf([COMMUNITY_ID])).toBe(
        getAddress(bob.address),
      )
      expect(await acceptanceEvents(f.namePolicy, hash)).toEqual([
        ['community', getAddress(bob.address), TERMS],
      ])
    })

    it('an acceptance is valid only for the offer it was made for', async () => {
      const f = await load()
      await acceptAndRegister(f)
      const first = await offerToBob(f)
      await f.namePolicy.write.acceptBonaFideCommunityTermsForClaim(
        [COMMUNITY_ID, alice.address, first, TERMS],
        {
          account: bob,
        },
      )
      const second = await offerToBob(f)
      const take = () =>
        f.baseRegistrar.write.transferFrom(
          [alice.address, bob.address, COMMUNITY_ID],
          {
            account: bob,
          },
        )
      await expect(take()).toBeRevertedWithCustomErrorFrom(
        f.namePolicy,
        'TermsNotAccepted',
      )
      await f.namePolicy.write.acceptBonaFideCommunityTermsForClaim(
        [COMMUNITY_ID, alice.address, second, TERMS],
        {
          account: bob,
        },
      )
      await take()
    })

    it('an acceptance is valid only for the holder it was made for', async () => {
      const f = await load()
      await acceptAndRegister(f)
      const offer = await offerToBob(f)
      await f.namePolicy.write.acceptBonaFideCommunityTermsForClaim(
        [COMMUNITY_ID, alice.address, offer, TERMS],
        {
          account: bob,
        },
      )
      await connection.networkHelpers.time.increase(
        MIN_REGISTRATION + GRACE_PERIOD + 1n,
      )
      const reg = communityFor(mallory.address)
      await f.namePolicy.write.commitUnderBonaFideCommunityTerms(
        [await f.controller.read.makeCommitment([reg]), TERMS],
        { account: mallory },
      )
      await f.controller.write.register([reg], {
        account: mallory,
        value: 2n * YEAR_PRICE_USD,
      })
      expect(await f.baseRegistrar.read.offers([COMMUNITY_ID])).toBe(offer)
      await f.baseRegistrar.write.setApprovalForAll([bob.address, true], {
        account: mallory,
      })
      const take = () =>
        f.baseRegistrar.write.transferFrom(
          [mallory.address, bob.address, COMMUNITY_ID],
          {
            account: bob,
          },
        )
      await expect(take()).toBeRevertedWithCustomErrorFrom(
        f.namePolicy,
        'TermsNotAccepted',
      )
      await f.namePolicy.write.acceptBonaFideCommunityTermsForClaim(
        [COMMUNITY_ID, mallory.address, offer, TERMS],
        {
          account: bob,
        },
      )
      await take()
    })

    it('new terms between acceptance and claim require a new acceptance', async () => {
      const f = await load()
      await acceptAndRegister(f)
      const offer = await offerToBob(f)
      await f.namePolicy.write.acceptBonaFideCommunityTermsForClaim(
        [COMMUNITY_ID, alice.address, offer, TERMS],
        {
          account: bob,
        },
      )
      await f.namePolicy.write.setTerms([NEW_TERMS, 'ipfs://terms-v2'], {
        account: owner,
      })
      const take = () =>
        f.baseRegistrar.write.transferFrom(
          [alice.address, bob.address, COMMUNITY_ID],
          {
            account: bob,
          },
        )
      await expect(take()).toBeRevertedWithCustomErrorFrom(
        f.namePolicy,
        'TermsNotAccepted',
      )
      await expect(
        f.namePolicy.write.acceptBonaFideCommunityTermsForClaim(
          [COMMUNITY_ID, alice.address, offer, TERMS],
          { account: bob },
        ),
      ).toBeRevertedWithCustomError('TermsMismatch')
      await f.namePolicy.write.acceptBonaFideCommunityTermsForClaim(
        [COMMUNITY_ID, alice.address, offer, NEW_TERMS],
        {
          account: bob,
        },
      )
      await take()
      expect(
        await f.namePolicy.read.acceptedClaimTerms([
          COMMUNITY_ID,
          alice.address,
          bob.address,
          offer,
        ]),
      ).toBe(zeroHash)
    })

    it('controller transfers require no claim acceptance: the resolver path and registerReserved', async () => {
      const f = await load()
      const reg = registration('community', alice.address, {
        resolver: f.resolver.address,
      })
      await f.namePolicy.write.commitUnderBonaFideCommunityTerms(
        [await f.controller.read.makeCommitment([reg]), TERMS],
        { account: alice },
      )
      await register(f.controller, reg)
      expect(await f.baseRegistrar.read.ownerOf([COMMUNITY_ID])).toBe(
        getAddress(alice.address),
      )

      await f.namePolicy.write.addBonaFideNames([['reservedone']], {
        account: guardian,
      })
      await f.namePolicy.write.addReservedNames([['reservedone'], TRADEMARK], {
        account: owner,
      })
      await f.namePolicy.write.registerReserved(
        ['reservedone', bob.address, MIN_REGISTRATION],
        {
          account: owner,
        },
      )
      expect(
        await f.baseRegistrar.read.ownerOf([BigInt(labelhash('reservedone'))]),
      ).toBe(getAddress(bob.address))
    })

    it('an unlisted name, and any name once the registrar hook is unset, transfers without acceptance', async () => {
      const f = await load()
      const plain = registration('plainname', alice.address)
      await f.controller.write.commit(
        [await f.controller.read.makeCommitment([plain])],
        { account: alice },
      )
      await register(f.controller, plain)
      const plainId = BigInt(labelhash('plainname'))
      await f.baseRegistrar.write.approve([bob.address, plainId], {
        account: alice,
      })
      await f.baseRegistrar.write.transferFrom(
        [alice.address, bob.address, plainId],
        { account: bob },
      )

      await acceptAndRegister(f)
      await offerToBob(f)
      await f.baseRegistrar.write.setNamePolicy([zeroAddress], {
        account: owner,
      })
      await f.baseRegistrar.write.transferFrom(
        [alice.address, bob.address, COMMUNITY_ID],
        {
          account: bob,
        },
      )
      expect(await f.baseRegistrar.read.ownerOf([COMMUNITY_ID])).toBe(
        getAddress(bob.address),
      )
    })

    it('only the base registrar consumes a claim acceptance', async () => {
      const { namePolicy } = await load()
      await expect(
        namePolicy.write.consumeTransfer(
          [COMMUNITY_ID, alice.address, bob.address, 0n, 'community'],
          {
            account: bob,
          },
        ),
      ).toBeRevertedWithCustomError('NotRegistrar')
    })
  })
})
