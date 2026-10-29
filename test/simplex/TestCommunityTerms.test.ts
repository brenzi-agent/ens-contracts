import type { UnknownCallPromise } from '@ensdomains/hardhat-chai-matchers-viem'
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
  commitUnderGeneralTerms,
  COMMUNITY_TERMS,
  COMMUNITY_TERMS_LINK,
  deployNamesV2,
  FAR_FUTURE,
  GENERAL_TERMS,
  GENERAL_TERMS_LINK,
  MIN_REGISTRATION,
  registration,
  signIntent,
  signRegistration,
  termsLink,
  YEAR,
  YEAR_PRICE_USD,
} from './fixtures/namesV2.js'
import { DAY } from '../fixtures/constants.js'

const TRADEMARK = 2 // SimplexNamePolicy.Reason.Trademark
const GRACE_PERIOD = 90n * DAY
const NEW_TERMS_LINK = termsLink('community-terms.md', '3')
const TERMS = COMMUNITY_TERMS
const NEW_TERMS = keccak256(toHex(NEW_TERMS_LINK))
const COMMUNITY_ID = BigInt(labelhash('community'))

const KINDS = [
  {
    title: 'general terms',
    label: 'plainname',
    id: BigInt(labelhash('plainname')),
    link: GENERAL_TERMS_LINK,
    hash: GENERAL_TERMS,
    otherHash: COMMUNITY_TERMS,
    setTerms: 'setGeneralTerms',
    termsLink: 'generalTermsLink',
    termsHash: 'generalTermsHash',
    termsSet: 'GeneralTermsSet',
    commit: 'commitUnderGeneralTerms',
    commitWithSig: 'commitUnderGeneralTermsWithSig',
    acceptForClaim: 'acceptGeneralTermsForClaim',
    acceptForClaimWithSig: 'acceptGeneralTermsForClaimWithSig',
    commitType: 'AcceptGeneralTerms',
    claimType: 'AcceptGeneralTermsForClaim',
  },
  {
    title: 'community terms',
    label: 'community',
    id: COMMUNITY_ID,
    link: COMMUNITY_TERMS_LINK,
    hash: COMMUNITY_TERMS,
    otherHash: GENERAL_TERMS,
    setTerms: 'setCommunityTerms',
    termsLink: 'communityTermsLink',
    termsHash: 'communityTermsHash',
    termsSet: 'CommunityTermsSet',
    commit: 'commitUnderCommunityTerms',
    commitWithSig: 'commitUnderCommunityTermsWithSig',
    acceptForClaim: 'acceptCommunityTermsForClaim',
    acceptForClaimWithSig: 'acceptCommunityTermsForClaimWithSig',
    commitType: 'AcceptCommunityTerms',
    claimType: 'AcceptCommunityTermsForClaim',
  },
] as const
type Kind = (typeof KINDS)[number]
const [GENERAL, COMMUNITY] = KINDS

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
  await f.namePolicy.write.addCommunityNames([['community']], {
    account: guardian,
  })
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)
type Fixture = Awaited<ReturnType<typeof fixture>>

const communityFor = (holder: `0x${string}`) =>
  registration('community', holder)

type WritePromise = UnknownCallPromise<`0x${string}`, 'write'>

const register = (
  controller: any,
  reg: ReturnType<typeof registration>,
): WritePromise =>
  controller.write.register([reg], {
    account: alice,
    value: 2n * YEAR_PRICE_USD,
  })

const callPolicy = (
  namePolicy: any,
  functionName: string,
  args: readonly unknown[],
  account: any,
): WritePromise => namePolicy.write[functionName](args, { account })

async function acceptAndRegister(
  { controller, namePolicy }: Fixture,
  k: Kind = COMMUNITY,
) {
  const reg = registration(k.label, alice.address)
  await callPolicy(
    namePolicy,
    k.commit,
    [await controller.read.makeCommitment([reg]), k.hash],
    alice,
  )
  return register(controller, reg)
}

async function acceptanceEvents(
  namePolicy: any,
  hash: `0x${string}`,
  eventName = 'CommunityTermsAccepted',
) {
  return parseEventLogs({
    abi: namePolicy.abi,
    eventName,
    logs: (await publicClient.waitForTransactionReceipt({ hash })).logs,
  }).map(({ args }) => [args.name, args.holder, args.termsHash])
}

const signAcceptance = async (
  namePolicy: any,
  signer: any,
  commitment: `0x${string}`,
  k: Kind = COMMUNITY,
) =>
  signIntent(
    publicClient,
    signer,
    'SimplexNamePolicy',
    namePolicy.address,
    k.commitType,
    {
      commitment,
      termsHash: k.hash,
      nonce: await namePolicy.read.nonces([signer.account.address]),
      deadline: FAR_FUTURE,
    },
  )

async function offerToBob({ baseRegistrar }: Fixture, id = COMMUNITY_ID) {
  await baseRegistrar.write.approve([bob.address, id], {
    account: alice,
  })
  return baseRegistrar.read.offers([id])
}

describe('community names', () => {
  describe('listing', () => {
    it('the guardian lists a free name, and only the owner removes it', async () => {
      const { namePolicy } = await load()
      await expect(
        namePolicy.write.addCommunityNames([['other']], { account: alice }),
      ).toBeRevertedWithCustomError('NotOwnerOrBeneficiary')
      await namePolicy.write.addCommunityNames([['other']], {
        account: guardian,
      })
      expect(await namePolicy.read.communityNames([labelhash('other')])).toBe(
        true,
      )

      await expect(
        namePolicy.write.removeCommunityNames([['other']], {
          account: guardian,
        }),
      ).toBeRevertedWithCustomError('NotOwner')
      await namePolicy.write.removeCommunityNames([['other']], {
        account: owner,
      })
      expect(await namePolicy.read.communityNames([labelhash('other')])).toBe(
        false,
      )
    })

    it('skips a name that is registered or in its grace period, and lists it once free', async () => {
      const { controller, namePolicy } = await load()
      const reg = registration('heldname', alice.address)
      await commitUnderGeneralTerms(connection, controller, reg, {
        account: alice,
      })
      await register(controller, reg)

      const list = () =>
        namePolicy.write.addCommunityNames([['heldname']], {
          account: guardian,
        })
      await expect(list())
        .toEmitEvent('CommunityNameSkipped')
        .withArgs({ name: 'heldname' })
      await connection.networkHelpers.time.increase(MIN_REGISTRATION + 1n)
      await expect(list())
        .toEmitEvent('CommunityNameSkipped')
        .withArgs({ name: 'heldname' })
      expect(
        await namePolicy.read.communityNames([labelhash('heldname')]),
      ).toBe(false)

      await connection.networkHelpers.time.increase(GRACE_PERIOD)
      await expect(list())
        .toEmitEvent('CommunityNameAdded')
        .withArgs({ name: 'heldname' })
      expect(
        await namePolicy.read.communityNames([labelhash('heldname')]),
      ).toBe(true)
    })

    it('pins the EIP-712 type hashes', async () => {
      const { namePolicy } = await load()
      expect(await namePolicy.read.ACCEPT_GENERAL_TERMS_TYPEHASH()).toBe(
        keccak256(
          toHex(
            'AcceptGeneralTerms(bytes32 commitment,bytes32 termsHash,uint256 nonce,uint256 deadline)',
          ),
        ),
      )
      expect(
        await namePolicy.read.ACCEPT_GENERAL_TERMS_FOR_CLAIM_TYPEHASH(),
      ).toBe(
        keccak256(
          toHex(
            'AcceptGeneralTermsForClaim(uint256 tokenId,address from,uint256 offer,bytes32 termsHash,uint256 nonce,uint256 deadline)',
          ),
        ),
      )
      expect(await namePolicy.read.ACCEPT_COMMUNITY_TERMS_TYPEHASH()).toBe(
        keccak256(
          toHex(
            'AcceptCommunityTerms(bytes32 commitment,bytes32 termsHash,uint256 nonce,uint256 deadline)',
          ),
        ),
      )
      expect(
        await namePolicy.read.ACCEPT_COMMUNITY_TERMS_FOR_CLAIM_TYPEHASH(),
      ).toBe(
        keccak256(
          toHex(
            'AcceptCommunityTermsForClaim(uint256 tokenId,address from,uint256 offer,bytes32 termsHash,uint256 nonce,uint256 deadline)',
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
  })

  describe('registration', () => {
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

    it('the registrar relays a signed acceptance and registers on credit', async () => {
      const { controller, sponsor, namePolicy, baseRegistrar } = await load()
      const reg = communityFor(bob.address)
      const commitment = await controller.read.makeCommitment([reg])
      await namePolicy.write.commitUnderCommunityTermsWithSig(
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
      await namePolicy.write.commitUnderCommunityTerms([commitment, TERMS], {
        account: mallory,
      })
      await expect(register(controller, reg)).toBeRevertedWithCustomErrorFrom(
        namePolicy,
        'TermsNotAccepted',
      )
      await namePolicy.write.commitUnderCommunityTerms([commitment, TERMS], {
        account: alice,
      })
      await register(controller, reg)
      expect(await baseRegistrar.read.ownerOf([COMMUNITY_ID])).toBe(
        getAddress(alice.address),
      )
    })

    it('new terms between commit and reveal require a new acceptance', async () => {
      const { controller, namePolicy } = await load()
      const reg = communityFor(alice.address)
      const commitment = await controller.read.makeCommitment([reg])
      await namePolicy.write.commitUnderCommunityTerms([commitment, TERMS], {
        account: alice,
      })
      await namePolicy.write.setCommunityTerms([NEW_TERMS_LINK], {
        account: owner,
      })
      await expect(register(controller, reg)).toBeRevertedWithCustomErrorFrom(
        namePolicy,
        'TermsNotAccepted',
      )
      await expect(
        namePolicy.write.commitUnderCommunityTerms([commitment, TERMS], {
          account: alice,
        }),
      ).toBeRevertedWithCustomError('TermsMismatch')
      await namePolicy.write.commitUnderCommunityTerms(
        [commitment, NEW_TERMS],
        {
          account: alice,
        },
      )
      await register(controller, reg)
    })

    it('a name listed between commit and register needs the community terms, and an unlisted one the general terms', async () => {
      const { controller, namePolicy, baseRegistrar } = await load()
      const plain = registration('plainname', alice.address)
      const plainCommitment = await controller.read.makeCommitment([plain])
      await namePolicy.write.commitUnderGeneralTerms(
        [plainCommitment, GENERAL_TERMS],
        { account: alice },
      )
      await namePolicy.write.addCommunityNames([['plainname']], {
        account: guardian,
      })
      await expect(register(controller, plain)).toBeRevertedWithCustomErrorFrom(
        namePolicy,
        'TermsNotAccepted',
      )
      await namePolicy.write.commitUnderCommunityTerms(
        [plainCommitment, TERMS],
        { account: alice },
      )
      const listed = await register(controller, plain)
      expect(await acceptanceEvents(namePolicy, listed)).toEqual([
        ['plainname', getAddress(alice.address), TERMS],
      ])

      const reg = communityFor(alice.address)
      const commitment = await controller.read.makeCommitment([reg])
      await namePolicy.write.commitUnderCommunityTerms([commitment, TERMS], {
        account: alice,
      })
      await namePolicy.write.removeCommunityNames([['community']], {
        account: owner,
      })
      await expect(register(controller, reg)).toBeRevertedWithCustomErrorFrom(
        namePolicy,
        'TermsNotAccepted',
      )
      await namePolicy.write.commitUnderGeneralTerms(
        [commitment, GENERAL_TERMS],
        {
          account: alice,
        },
      )
      const unlisted = await register(controller, reg)
      expect(
        await acceptanceEvents(namePolicy, unlisted, 'GeneralTermsAccepted'),
      ).toEqual([['community', getAddress(alice.address), GENERAL_TERMS]])
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

  describe('duration', () => {
    it('the sponsor registers a listed name for three years, not a second more', async () => {
      const { controller, sponsor, namePolicy } = await load()
      const tooLong = registration('community', bob.address, {
        duration: 3n * YEAR + 1n,
      })
      await expect(
        sponsor.write.registerWithCredit(
          await signRegistration(connection, sponsor, tooLong),
          { account: registrar },
        ),
      ).toBeRevertedWithCustomErrorFrom(controller, 'DurationTooLong')

      const reg = registration('community', bob.address, {
        duration: 3n * YEAR,
      })
      await namePolicy.write.commitUnderCommunityTerms(
        [await controller.read.makeCommitment([reg]), TERMS],
        { account: bob },
      )
      await sponsor.write.registerWithCredit(
        await signRegistration(connection, sponsor, reg),
        { account: registrar },
      )
    })

    it('the sponsor renews a listed name up to three years out, not further', async () => {
      const f = await load()
      await acceptAndRegister(f)
      await f.sponsor.write.renewWithCredit(['community', YEAR, zeroHash], {
        account: registrar,
      })
      await expect(
        f.sponsor.write.renewWithCredit(['community', YEAR, zeroHash], {
          account: registrar,
        }),
      ).toBeRevertedWithCustomErrorFrom(f.controller, 'DurationTooLong')
    })

    it('registerReserved registers a listed name for three years, not a second more', async () => {
      const { namePolicy } = await load()
      await namePolicy.write.addReservedNames([['community'], TRADEMARK], {
        account: owner,
      })
      await expect(
        namePolicy.write.registerReserved(
          ['community', bob.address, 3n * YEAR + 1n],
          { account: owner },
        ),
      ).toBeRevertedWithCustomError('DurationTooLong')
      await namePolicy.write.registerReserved(
        ['community', bob.address, 3n * YEAR],
        { account: owner },
      )
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
      await f.namePolicy.write.acceptCommunityTermsForClaim(
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
        'AcceptCommunityTermsForClaim',
        {
          tokenId: COMMUNITY_ID,
          from: alice.address,
          offer,
          termsHash: TERMS,
          nonce: 0n,
          deadline: FAR_FUTURE,
        },
      )
      await f.namePolicy.write.acceptCommunityTermsForClaimWithSig(
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
      await f.namePolicy.write.acceptCommunityTermsForClaim(
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
      await f.namePolicy.write.acceptCommunityTermsForClaim(
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
      await f.namePolicy.write.acceptCommunityTermsForClaim(
        [COMMUNITY_ID, alice.address, offer, TERMS],
        {
          account: bob,
        },
      )
      await connection.networkHelpers.time.increase(
        MIN_REGISTRATION + GRACE_PERIOD + 1n,
      )
      const reg = communityFor(mallory.address)
      await f.namePolicy.write.commitUnderCommunityTerms(
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
      await f.namePolicy.write.acceptCommunityTermsForClaim(
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
      await f.namePolicy.write.acceptCommunityTermsForClaim(
        [COMMUNITY_ID, alice.address, offer, TERMS],
        {
          account: bob,
        },
      )
      await f.namePolicy.write.setCommunityTerms([NEW_TERMS_LINK], {
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
        f.namePolicy.write.acceptCommunityTermsForClaim(
          [COMMUNITY_ID, alice.address, offer, TERMS],
          { account: bob },
        ),
      ).toBeRevertedWithCustomError('TermsMismatch')
      await f.namePolicy.write.acceptCommunityTermsForClaim(
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
      await f.namePolicy.write.commitUnderCommunityTerms(
        [await f.controller.read.makeCommitment([reg]), TERMS],
        { account: alice },
      )
      await register(f.controller, reg)
      expect(await f.baseRegistrar.read.ownerOf([COMMUNITY_ID])).toBe(
        getAddress(alice.address),
      )

      await f.namePolicy.write.addCommunityNames([['reservedone']], {
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

    it('an unlisted name transfers under the general terms, and any name without acceptance once the registrar hook is unset', async () => {
      const f = await load()
      await acceptAndRegister(f, GENERAL)
      const offer = await offerToBob(f, GENERAL.id)
      const take = () =>
        f.baseRegistrar.write.transferFrom(
          [alice.address, bob.address, GENERAL.id],
          { account: bob },
        )
      await expect(take()).toBeRevertedWithCustomErrorFrom(
        f.namePolicy,
        'TermsNotAccepted',
      )
      await f.namePolicy.write.acceptGeneralTermsForClaim(
        [GENERAL.id, alice.address, offer, GENERAL_TERMS],
        { account: bob },
      )
      expect(
        await acceptanceEvents(
          f.namePolicy,
          await take(),
          'GeneralTermsAccepted',
        ),
      ).toEqual([['plainname', getAddress(bob.address), GENERAL_TERMS]])

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

describe('terms of each kind', () => {
  for (const k of KINDS) {
    const other = k === GENERAL ? COMMUNITY : GENERAL
    const reg = registration(k.label, alice.address)

    const policyWithoutTheseTerms = async ({
      namePolicyImplementation,
    }: Fixture) => {
      const proxy = await connection.viem.deployContract(
        'SimplexNamePolicyProxy',
        [namePolicyImplementation.address, '0x'],
      )
      const unset = await connection.viem.getContractAt(
        'SimplexNamePolicy',
        proxy.address,
      )
      await unset.write.addCommunityNames([['community']], {
        account: guardian,
      })
      await callPolicy(unset, other.setTerms, [other.link], owner)
      return unset
    }

    describe(k.title, () => {
      it('a name cannot be registered without accepting its terms, on either path', async () => {
        const { controller, sponsor, namePolicy } = await load()
        await controller.write.commit(
          [await controller.read.makeCommitment([reg])],
          { account: alice },
        )
        await expect(register(controller, reg)).toBeRevertedWithCustomErrorFrom(
          namePolicy,
          'TermsNotAccepted',
        )
        await expect(
          sponsor.write.registerWithCredit(
            await signRegistration(connection, sponsor, reg),
            { account: registrar },
          ),
        ).toBeRevertedWithCustomErrorFrom(namePolicy, 'TermsNotAccepted')
      })

      it('only the owner sets the link, never empty, and it is stored with its hash', async () => {
        const { namePolicy } = await load()
        const link = termsLink('next.md', '4')
        const hash = keccak256(toHex(link))
        await expect(
          callPolicy(namePolicy, k.setTerms, [link], guardian),
        ).toBeRevertedWithCustomError('NotOwner')
        await expect(
          callPolicy(namePolicy, k.setTerms, [''], owner),
        ).toBeRevertedWithCustomError('ZeroTerms')
        await expect(callPolicy(namePolicy, k.setTerms, [link], owner))
          .toEmitEvent(k.termsSet)
          .withArgs({ termsHash: hash, link })
        expect(await namePolicy.read[k.termsLink]()).toBe(link)
        expect(await namePolicy.read[k.termsHash]()).toBe(hash)
      })

      it('a new link leaves the other terms and their acceptances valid', async () => {
        const f = await load()
        const otherReg = registration(other.label, alice.address)
        await callPolicy(
          f.namePolicy,
          other.commit,
          [await f.controller.read.makeCommitment([otherReg]), other.hash],
          alice,
        )
        await callPolicy(
          f.namePolicy,
          k.setTerms,
          [termsLink('next.md', '4')],
          owner,
        )
        expect(await f.namePolicy.read[other.termsHash]()).toBe(other.hash)
        await register(f.controller, otherReg)

        const offer = await offerToBob(f, other.id)
        await callPolicy(
          f.namePolicy,
          other.acceptForClaim,
          [other.id, alice.address, offer, other.hash],
          bob,
        )
        await callPolicy(
          f.namePolicy,
          k.setTerms,
          [termsLink('next.md', '5')],
          owner,
        )
        await f.baseRegistrar.write.transferFrom(
          [alice.address, bob.address, other.id],
          { account: bob },
        )
      })

      it('an acceptance reverts for the other terms and for none', async () => {
        const { controller, namePolicy } = await load()
        const commitment = await controller.read.makeCommitment([reg])
        for (const hash of [k.otherHash, zeroHash]) {
          await expect(
            callPolicy(namePolicy, k.commit, [commitment, hash], alice),
          ).toBeRevertedWithCustomError('TermsMismatch')
          await expect(
            callPolicy(
              namePolicy,
              k.acceptForClaim,
              [k.id, alice.address, 0n, hash],
              bob,
            ),
          ).toBeRevertedWithCustomError('TermsMismatch')
        }
      })

      it('registration and claim refuse an acceptance of the other terms', async () => {
        const f = await load()
        const commitment = await f.controller.read.makeCommitment([reg])
        await callPolicy(
          f.namePolicy,
          other.commit,
          [commitment, other.hash],
          alice,
        )
        await expect(
          register(f.controller, reg),
        ).toBeRevertedWithCustomErrorFrom(f.namePolicy, 'TermsNotAccepted')
        await callPolicy(f.namePolicy, k.commit, [commitment, k.hash], alice)
        await register(f.controller, reg)

        const offer = await offerToBob(f, k.id)
        await callPolicy(
          f.namePolicy,
          other.acceptForClaim,
          [k.id, alice.address, offer, other.hash],
          bob,
        )
        const take = () =>
          f.baseRegistrar.write.transferFrom(
            [alice.address, bob.address, k.id],
            { account: bob },
          )
        await expect(take()).toBeRevertedWithCustomErrorFrom(
          f.namePolicy,
          'TermsNotAccepted',
        )
        await callPolicy(
          f.namePolicy,
          k.acceptForClaim,
          [k.id, alice.address, offer, k.hash],
          bob,
        )
        await take()
      })

      it('a signed acceptance reverts from the wrong signer, on replay and after its deadline', async () => {
        const { controller, namePolicy } = await load()
        const commitment = await controller.read.makeCommitment([
          registration(k.label, bob.address),
        ])
        const relay = (deadline: bigint, sig: `0x${string}`) =>
          callPolicy(
            namePolicy,
            k.commitWithSig,
            [commitment, k.hash, bob.address, 0n, deadline, sig],
            registrar,
          )
        await expect(
          relay(
            FAR_FUTURE,
            await signAcceptance(namePolicy, malloryClient, commitment, k),
          ),
        ).toBeRevertedWithCustomError('InvalidSignature')
        await expect(relay(1n, '0x')).toBeRevertedWithCustomError(
          'SignatureExpired',
        )
        const sig = await signAcceptance(namePolicy, bobClient, commitment, k)
        await relay(FAR_FUTURE, sig)
        await expect(relay(FAR_FUTURE, sig)).toBeRevertedWithCustomError(
          'InvalidNonce',
        )
      })

      it('a signed claim acceptance reverts from the wrong signer, on replay and after its deadline', async () => {
        const f = await load()
        await acceptAndRegister(f, k)
        const offer = await offerToBob(f, k.id)
        const sign = (client: any) =>
          signIntent(
            publicClient,
            client,
            'SimplexNamePolicy',
            f.namePolicy.address,
            k.claimType,
            {
              tokenId: k.id,
              from: alice.address,
              offer,
              termsHash: k.hash,
              nonce: 0n,
              deadline: FAR_FUTURE,
            },
          )
        const relay = (deadline: bigint, sig: `0x${string}`) =>
          callPolicy(
            f.namePolicy,
            k.acceptForClaimWithSig,
            [
              k.id,
              alice.address,
              offer,
              k.hash,
              bob.address,
              0n,
              deadline,
              sig,
            ],
            registrar,
          )
        await expect(
          relay(FAR_FUTURE, await sign(malloryClient)),
        ).toBeRevertedWithCustomError('InvalidSignature')
        await expect(relay(1n, '0x')).toBeRevertedWithCustomError(
          'SignatureExpired',
        )
        const sig = await sign(bobClient)
        await relay(FAR_FUTURE, sig)
        await expect(relay(FAR_FUTURE, sig)).toBeRevertedWithCustomError(
          'InvalidNonce',
        )
      })

      it('nothing is accepted or registered before the link is set', async () => {
        const f = await load()
        const unset = await policyWithoutTheseTerms(f)
        await f.controller.write.setNamePolicy([unset.address], {
          account: owner,
        })
        const commitment = await f.controller.read.makeCommitment([reg])
        for (const hash of [zeroHash, k.hash]) {
          await expect(
            callPolicy(unset, k.commit, [commitment, hash], alice),
          ).toBeRevertedWithCustomError('TermsMismatch')
        }
        await f.controller.write.commit([commitment], { account: alice })
        await expect(
          register(f.controller, reg),
        ).toBeRevertedWithCustomErrorFrom(unset, 'TermsNotAccepted')
      })

      it('nothing is claimed before the link is set', async () => {
        const f = await load()
        await acceptAndRegister(f, k)
        const offer = await offerToBob(f, k.id)
        const unset = await policyWithoutTheseTerms(f)
        await expect(
          callPolicy(
            unset,
            k.acceptForClaim,
            [k.id, alice.address, offer, k.hash],
            bob,
          ),
        ).toBeRevertedWithCustomError('TermsMismatch')
        await f.baseRegistrar.write.setNamePolicy([unset.address], {
          account: owner,
        })
        await expect(
          f.baseRegistrar.write.transferFrom(
            [alice.address, bob.address, k.id],
            { account: bob },
          ),
        ).toBeRevertedWithCustomErrorFrom(unset, 'TermsNotAccepted')
      })
    })
  }

  describe('front-running', () => {
    it('a third party committing the same commitment first leaves the acceptance valid', async () => {
      const { controller, namePolicy, baseRegistrar } = await load()
      const reg = registration('plainname', alice.address)
      const commitment = await controller.read.makeCommitment([reg])
      await controller.write.commit([commitment], { account: mallory })
      await namePolicy.write.commitUnderGeneralTerms(
        [commitment, GENERAL_TERMS],
        {
          account: alice,
        },
      )
      expect(
        await namePolicy.read.acceptedTerms([commitment, alice.address]),
      ).toBe(GENERAL_TERMS)
      await register(controller, reg)
      expect(await baseRegistrar.read.ownerOf([GENERAL.id])).toBe(
        getAddress(alice.address),
      )
    })

    it("a copied signed acceptance records only the signer's acceptance", async () => {
      const { controller, sponsor, namePolicy, baseRegistrar } = await load()
      const reg = registration('plainname', bob.address)
      const commitment = await controller.read.makeCommitment([reg])
      const sig = await signAcceptance(
        namePolicy,
        bobClient,
        commitment,
        GENERAL,
      )
      const relay = (account: any) =>
        namePolicy.write.commitUnderGeneralTermsWithSig(
          [commitment, GENERAL_TERMS, bob.address, 0n, FAR_FUTURE, sig],
          { account },
        )
      await relay(mallory)
      expect(
        await namePolicy.read.acceptedTerms([commitment, bob.address]),
      ).toBe(GENERAL_TERMS)
      expect(
        await namePolicy.read.acceptedTerms([commitment, mallory.address]),
      ).toBe(zeroHash)
      await expect(relay(registrar)).toBeRevertedWithCustomError('InvalidNonce')
      await sponsor.write.registerWithCredit(
        await signRegistration(connection, sponsor, reg),
        { account: registrar },
      )
      expect(await baseRegistrar.read.ownerOf([GENERAL.id])).toBe(
        getAddress(bob.address),
      )
    })

    it('a signature of one kind is refused as the other, and an older one once a newer is used', async () => {
      const { controller, namePolicy } = await load()
      const community = await controller.read.makeCommitment([
        communityFor(bob.address),
      ])
      const plain = await controller.read.makeCommitment([
        registration('plainname', bob.address),
      ])
      const older = await signAcceptance(namePolicy, bobClient, community)
      const newer = await signAcceptance(namePolicy, bobClient, plain, GENERAL)
      await expect(
        namePolicy.write.commitUnderCommunityTermsWithSig(
          [plain, GENERAL_TERMS, bob.address, 0n, FAR_FUTURE, newer],
          { account: registrar },
        ),
      ).toBeRevertedWithCustomError('InvalidSignature')
      await namePolicy.write.commitUnderGeneralTermsWithSig(
        [plain, GENERAL_TERMS, bob.address, 0n, FAR_FUTURE, newer],
        { account: registrar },
      )
      await expect(
        namePolicy.write.commitUnderCommunityTermsWithSig(
          [community, TERMS, bob.address, 0n, FAR_FUTURE, older],
          { account: registrar },
        ),
      ).toBeRevertedWithCustomError('InvalidNonce')
    })
  })
})
