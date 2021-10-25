import nock from 'nock'
import { gql } from 'apollo-server-koa'
import Knex from 'knex'
import { StreamServer } from '@interledger/stream-receiver'
import { PaymentError, PaymentType } from '@interledger/pay'
import { v4 as uuid } from 'uuid'
import * as Pay from '@interledger/pay'

import { createTestApp, TestContainer } from '../../tests/app'
import { IocContract } from '@adonisjs/fold'
import { AppServices } from '../../app'
import { initIocContainer } from '../..'
import { Config } from '../../config/app'
import { AccountFactory } from '../../tests/accountFactory'
import { truncateTables } from '../../tests/tableManager'
import { OutgoingPaymentService } from '../../outgoing_payment/service'
import {
  OutgoingPayment as OutgoingPaymentModel,
  PaymentState
} from '../../outgoing_payment/model'
import { AccountService } from '../../account/service'
import { Balance, BalanceService } from '../../balance/service'
import {
  Account,
  OutgoingPayment,
  OutgoingPaymentResponse,
  PaymentState as SchemaPaymentState,
  PaymentType as SchemaPaymentType
} from '../generated/graphql'

describe('OutgoingPayment Resolvers', (): void => {
  let deps: IocContract<AppServices>
  let appContainer: TestContainer
  let knex: Knex
  let accountService: AccountService
  let balanceService: BalanceService
  let outgoingPaymentService: OutgoingPaymentService

  const streamServer = new StreamServer({
    serverSecret: Buffer.from(
      '61a55774643daa45bec703385ea6911dbaaaa9b4850b77884f2b8257eef05836',
      'hex'
    ),
    serverAddress: 'test.wallet'
  })

  beforeAll(
    async (): Promise<void> => {
      deps = await initIocContainer(Config)
      appContainer = await createTestApp(deps)
      knex = await deps.use('knex')
      accountService = await deps.use('accountService')
      balanceService = await deps.use('balanceService')
      outgoingPaymentService = await deps.use('outgoingPaymentService')

      const credentials = streamServer.generateCredentials({
        asset: {
          code: 'XRP',
          scale: 9
        }
      })
      nock('http://wallet2.example')
        .get('/paymentpointer/bob')
        .reply(200, {
          destination_account: credentials.ilpAddress,
          shared_secret: credentials.sharedSecret.toString('base64')
        })
    }
  )

  afterAll(
    async (): Promise<void> => {
      await truncateTables(knex)
      await appContainer.apolloClient.stop()
      await appContainer.shutdown()
    }
  )

  let payment: OutgoingPaymentModel

  beforeEach(
    async (): Promise<void> => {
      const accountFactory = new AccountFactory(accountService)
      const { id: sourceAccountId, asset } = await accountFactory.build()
      const accountId = (await accountFactory.build({ asset })).id
      payment = await OutgoingPaymentModel.query(knex).insertAndFetch({
        state: PaymentState.Inactive,
        intent: {
          paymentPointer: 'http://wallet2.example/paymentpointer/bob',
          amountToSend: BigInt(123),
          autoApprove: false
        },
        quote: {
          timestamp: new Date(),
          activationDeadline: new Date(Date.now() + 1000),
          targetType: PaymentType.FixedSend,
          minDeliveryAmount: BigInt(123),
          maxSourceAmount: BigInt(456),
          maxPacketAmount: BigInt(789),
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          minExchangeRate: Pay.Ratio.from(1.23)!,
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          lowExchangeRateEstimate: Pay.Ratio.from(1.2)!,
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          highExchangeRateEstimate: Pay.Ratio.from(2.3)!
        },
        accountId,
        reservedBalanceId: uuid(),
        sourceAccount: {
          id: sourceAccountId,
          scale: 9,
          code: 'USD'
        },
        destinationAccount: {
          scale: 9,
          code: 'XRP',
          url: 'http://wallet2.example/paymentpointer/bob'
        }
      })
    }
  )

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('Query.outgoingPayment', (): void => {
    test('200', async (): Promise<void> => {
      jest
        .spyOn(outgoingPaymentService, 'get')
        .mockImplementation(async () => payment)
      jest
        .spyOn(accountService, 'getBalance')
        .mockImplementation(async () => BigInt(45))
      jest
        .spyOn(balanceService, 'get')
        .mockImplementation(async (id: string) => {
          expect(id).toStrictEqual(payment.reservedBalanceId)
          return {
            balance: BigInt(123)
          } as Balance
        })

      const query = await appContainer.apolloClient
        .query({
          query: gql`
            query OutgoingPayment($paymentId: String!) {
              outgoingPayment(id: $paymentId) {
                id
                state
                error
                stateAttempts
                intent {
                  paymentPointer
                  invoiceUrl
                  amountToSend
                  autoApprove
                }
                quote {
                  timestamp
                  activationDeadline
                  targetType
                  minDeliveryAmount
                  maxSourceAmount
                  maxPacketAmount
                  minExchangeRate
                  lowExchangeRateEstimate
                  highExchangeRateEstimate
                }
                accountId
                reservedBalanceId
                sourceAccount {
                  id
                  scale
                  code
                }
                destinationAccount {
                  scale
                  code
                  url
                }
                outcome {
                  amountSent
                }
                createdAt
              }
            }
          `,
          variables: {
            paymentId: payment.id
          }
        })
        .then((query): OutgoingPayment => query.data?.outgoingPayment)

      expect(query.id).toEqual(payment.id)
      expect(query.state).toEqual(SchemaPaymentState.Inactive)
      expect(query.error).toBeNull()
      expect(query.stateAttempts).toBe(0)
      expect(query.intent).toEqual({
        ...payment.intent,
        amountToSend: payment.intent?.amountToSend?.toString(),
        invoiceUrl: null,
        __typename: 'PaymentIntent'
      })
      expect(query.quote).toEqual({
        ...payment.quote,
        timestamp: payment.quote?.timestamp.toISOString(),
        activationDeadline: payment.quote?.activationDeadline.toISOString(),
        targetType: SchemaPaymentType.FixedSend,
        minDeliveryAmount: payment.quote?.minDeliveryAmount.toString(),
        maxSourceAmount: payment.quote?.maxSourceAmount.toString(),
        maxPacketAmount: payment.quote?.maxPacketAmount.toString(),
        minExchangeRate: payment.quote?.minExchangeRate.valueOf(),
        lowExchangeRateEstimate: payment.quote?.lowExchangeRateEstimate.valueOf(),
        highExchangeRateEstimate: payment.quote?.highExchangeRateEstimate.valueOf(),
        __typename: 'PaymentQuote'
      })
      expect(query.accountId).toBe(payment.accountId)
      expect(query.reservedBalanceId).toBe(payment.reservedBalanceId)
      expect(query.sourceAccount).toEqual({
        ...payment.sourceAccount,
        __typename: 'PaymentSourceAccount'
      })
      expect(query.destinationAccount).toEqual({
        ...payment.destinationAccount,
        __typename: 'PaymentDestinationAccount'
      })
      expect(query.outcome).toEqual({
        amountSent: (123 - 45).toString(),
        __typename: 'OutgoingPaymentOutcome'
      })
      expect(new Date(query.createdAt)).toEqual(payment.createdAt)
    })

    test('404', async (): Promise<void> => {
      jest
        .spyOn(outgoingPaymentService, 'get')
        .mockImplementation(async () => undefined)

      await expect(
        appContainer.apolloClient.query({
          query: gql`
            query OutgoingPayment($paymentId: String!) {
              outgoingPayment(id: $paymentId) {
                id
              }
            }
          `,
          variables: { paymentId: uuid() }
        })
      ).rejects.toThrow('payment does not exist')
    })
  })

  describe('Mutation.createOutgoingPayment', (): void => {
    const input = {
      sourceAccountId: uuid(),
      paymentPointer: 'http://wallet2.example/paymentpointer/bob',
      amountToSend: '123',
      autoApprove: false
    }

    test('200', async (): Promise<void> => {
      jest
        .spyOn(outgoingPaymentService, 'create')
        .mockImplementation(async (args) => {
          expect(args).toEqual({
            ...input,
            amountToSend: BigInt(input.amountToSend)
          })
          return payment
        })

      const query = await appContainer.apolloClient
        .query({
          query: gql`
            mutation CreateOutgoingPayment(
              $input: CreateOutgoingPaymentInput!
            ) {
              createOutgoingPayment(input: $input) {
                code
                success
                payment {
                  id
                  state
                }
              }
            }
          `,
          variables: { input }
        })
        .then(
          (query): OutgoingPaymentResponse => query.data?.createOutgoingPayment
        )

      expect(query.code).toBe('200')
      expect(query.success).toBe(true)
      expect(query.payment?.id).toBe(payment.id)
      expect(query.payment?.state).toBe(SchemaPaymentState.Inactive)
    })

    test('400', async (): Promise<void> => {
      jest
        .spyOn(outgoingPaymentService, 'create')
        .mockImplementation(async (_args) => {
          throw PaymentError.InvalidPaymentPointer
        })

      const query = await appContainer.apolloClient
        .query({
          query: gql`
            mutation CreateOutgoingPayment(
              $input: CreateOutgoingPaymentInput!
            ) {
              createOutgoingPayment(input: $input) {
                code
                success
                message
                payment {
                  id
                  state
                }
              }
            }
          `,
          variables: { input }
        })
        .then(
          (query): OutgoingPaymentResponse => query.data?.createOutgoingPayment
        )
      expect(query.code).toBe('400')
      expect(query.success).toBe(false)
      expect(query.message).toBe(PaymentError.InvalidPaymentPointer)
      expect(query.payment).toBeNull()
    })

    test('500', async (): Promise<void> => {
      jest
        .spyOn(outgoingPaymentService, 'create')
        .mockImplementation(async (_args) => {
          throw PaymentError.ReceiverProtocolViolation
        })

      const query = await appContainer.apolloClient
        .query({
          query: gql`
            mutation CreateOutgoingPayment(
              $input: CreateOutgoingPaymentInput!
            ) {
              createOutgoingPayment(input: $input) {
                code
                success
                message
                payment {
                  id
                  state
                }
              }
            }
          `,
          variables: { input }
        })
        .then(
          (query): OutgoingPaymentResponse => query.data?.createOutgoingPayment
        )
      expect(query.code).toBe('500')
      expect(query.success).toBe(false)
      expect(query.message).toBe(PaymentError.ReceiverProtocolViolation)
      expect(query.payment).toBeNull()
    })
  })

  describe(`Mutation.requoteOutgoingPayment`, (): void => {
    test('200', async (): Promise<void> => {
      const spy = jest
        .spyOn(outgoingPaymentService, 'requote')
        .mockImplementation(async (id: string) => {
          expect(id).toBe(payment.id)
          return payment
        })
      const query = await appContainer.apolloClient
        .query({
          query: gql`
            mutation RequoteOutgoingPayment($paymentId: String!) {
              requoteOutgoingPayment(paymentId: $paymentId) {
                code
                success
                message
                payment {
                  id
                }
              }
            }
          `,
          variables: { paymentId: payment.id }
        })
        .then(
          (query): OutgoingPaymentResponse => query.data?.requoteOutgoingPayment
        )
      expect(spy).toHaveBeenCalledTimes(1)
      expect(query.code).toBe('200')
      expect(query.success).toBe(true)
      expect(query.message).toBeNull()
      expect(query.payment?.id).toBe(payment.id)
    })

    test('500', async (): Promise<void> => {
      const spy = jest
        .spyOn(outgoingPaymentService, 'requote')
        .mockImplementation(async (id: string) => {
          expect(id).toBe(payment.id)
          throw new Error('fail')
        })
      const query = await appContainer.apolloClient
        .query({
          query: gql`
            mutation RequoteOutgoingPayment($paymentId: String!) {
              requoteOutgoingPayment(paymentId: $paymentId) {
                code
                success
                message
                payment {
                  id
                }
              }
            }
          `,
          variables: { paymentId: payment.id }
        })
        .then(
          (query): OutgoingPaymentResponse => query.data?.requoteOutgoingPayment
        )
      expect(spy).toHaveBeenCalledTimes(1)
      expect(query.code).toBe('500')
      expect(query.success).toBe(false)
      expect(query.message).toBe('fail')
      expect(query.payment).toBeNull()
    })
  })

  describe(`Mutation.approveOutgoingPayment`, (): void => {
    test('200', async (): Promise<void> => {
      const spy = jest
        .spyOn(outgoingPaymentService, 'approve')
        .mockImplementation(async (id: string) => {
          expect(id).toBe(payment.id)
          return payment
        })
      const query = await appContainer.apolloClient
        .query({
          query: gql`
            mutation ApproveOutgoingPayment($paymentId: String!) {
              approveOutgoingPayment(paymentId: $paymentId) {
                code
                success
                message
                payment {
                  id
                }
              }
            }
          `,
          variables: { paymentId: payment.id }
        })
        .then(
          (query): OutgoingPaymentResponse => query.data?.approveOutgoingPayment
        )
      expect(spy).toHaveBeenCalledTimes(1)
      expect(query.code).toBe('200')
      expect(query.success).toBe(true)
      expect(query.message).toBeNull()
      expect(query.payment?.id).toBe(payment.id)
    })

    test('500', async (): Promise<void> => {
      const spy = jest
        .spyOn(outgoingPaymentService, 'approve')
        .mockImplementation(async (id: string) => {
          expect(id).toBe(payment.id)
          throw new Error('fail')
        })
      const query = await appContainer.apolloClient
        .query({
          query: gql`
            mutation ApproveOutgoingPayment($paymentId: String!) {
              approveOutgoingPayment(paymentId: $paymentId) {
                code
                success
                message
                payment {
                  id
                }
              }
            }
          `,
          variables: { paymentId: payment.id }
        })
        .then(
          (query): OutgoingPaymentResponse => query.data?.approveOutgoingPayment
        )
      expect(spy).toHaveBeenCalledTimes(1)
      expect(query.code).toBe('500')
      expect(query.success).toBe(false)
      expect(query.message).toBe('fail')
      expect(query.payment).toBeNull()
    })
  })

  describe(`Mutation.cancelOutgoingPayment`, (): void => {
    test('200', async (): Promise<void> => {
      const spy = jest
        .spyOn(outgoingPaymentService, 'cancel')
        .mockImplementation(async (id: string) => {
          expect(id).toBe(payment.id)
          return payment
        })
      const query = await appContainer.apolloClient
        .query({
          query: gql`
            mutation CancelOutgoingPayment($paymentId: String!) {
              cancelOutgoingPayment(paymentId: $paymentId) {
                code
                success
                message
                payment {
                  id
                }
              }
            }
          `,
          variables: { paymentId: payment.id }
        })
        .then(
          (query): OutgoingPaymentResponse => query.data?.cancelOutgoingPayment
        )
      expect(spy).toHaveBeenCalledTimes(1)
      expect(query.code).toBe('200')
      expect(query.success).toBe(true)
      expect(query.message).toBeNull()
      expect(query.payment?.id).toBe(payment.id)
    })

    test('500', async (): Promise<void> => {
      const spy = jest
        .spyOn(outgoingPaymentService, 'cancel')
        .mockImplementation(async (id: string) => {
          expect(id).toBe(payment.id)
          throw new Error('fail')
        })
      const query = await appContainer.apolloClient
        .query({
          query: gql`
            mutation CancelOutgoingPayment($paymentId: String!) {
              cancelOutgoingPayment(paymentId: $paymentId) {
                code
                success
                message
                payment {
                  id
                }
              }
            }
          `,
          variables: { paymentId: payment.id }
        })
        .then(
          (query): OutgoingPaymentResponse => query.data?.cancelOutgoingPayment
        )
      expect(spy).toHaveBeenCalledTimes(1)
      expect(query.code).toBe('500')
      expect(query.success).toBe(false)
      expect(query.message).toBe('fail')
      expect(query.payment).toBeNull()
    })
  })

  describe('Account outgoingPayments', (): void => {
    let outgoingPayments: OutgoingPaymentModel[]
    let accountFactory: AccountFactory
    let accountId: string
    beforeAll(
      async (): Promise<void> => {
        accountFactory = new AccountFactory(accountService)
        const { id: sourceAccountId, asset } = await accountFactory.build()
        accountId = sourceAccountId
        const paymentAccountId = (await accountFactory.build({ asset })).id
        outgoingPayments = []
        for (let i = 0; i < 50; i++) {
          outgoingPayments.push(
            await OutgoingPaymentModel.query(knex).insertAndFetch({
              state: PaymentState.Inactive,
              intent: {
                paymentPointer: 'http://wallet2.example/paymentpointer/bob',
                amountToSend: BigInt(123),
                autoApprove: false
              },
              quote: {
                timestamp: new Date(),
                activationDeadline: new Date(Date.now() + 1000),
                targetType: PaymentType.FixedSend,
                minDeliveryAmount: BigInt(123),
                maxSourceAmount: BigInt(456),
                maxPacketAmount: BigInt(789),
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                minExchangeRate: Pay.Ratio.from(1.23)!,
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                lowExchangeRateEstimate: Pay.Ratio.from(1.2)!,
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                highExchangeRateEstimate: Pay.Ratio.from(2.3)!
              },
              accountId: paymentAccountId,
              reservedBalanceId: uuid(),
              sourceAccount: {
                id: sourceAccountId,
                scale: 9,
                code: 'USD'
              },
              destinationAccount: {
                scale: 9,
                code: 'XRP',
                url: 'http://wallet2.example/paymentpointer/bob'
              }
            })
          )
        }
      }
    )

    test('pageInfo is correct on default query without params', async (): Promise<void> => {
      const query = await appContainer.apolloClient
        .query({
          query: gql`
            query Account($id: String!) {
              account(id: $id) {
                outgoingPayments {
                  edges {
                    node {
                      id
                    }
                    cursor
                  }
                  pageInfo {
                    endCursor
                    hasNextPage
                    hasPreviousPage
                    startCursor
                  }
                }
              }
            }
          `,
          variables: {
            id: accountId
          }
        })
        .then(
          (query): Account => {
            if (query.data) {
              return query.data.account
            } else {
              throw new Error('Data was empty')
            }
          }
        )
      expect(query.outgoingPayments?.edges).toHaveLength(20)
      expect(query.outgoingPayments?.pageInfo.hasNextPage).toBeTruthy()
      expect(query.outgoingPayments?.pageInfo.hasPreviousPage).toBeFalsy()
      expect(query.outgoingPayments?.pageInfo.startCursor).toEqual(
        outgoingPayments[0].id
      )
      expect(query.outgoingPayments?.pageInfo.endCursor).toEqual(
        outgoingPayments[19].id
      )
    })

    test('No outgoingPayments, but outgoingPayments requested', async (): Promise<void> => {
      const tempAccount = await accountFactory.build()
      const query = await appContainer.apolloClient
        .query({
          query: gql`
            query Account($id: String!) {
              account(id: $id) {
                outgoingPayments {
                  edges {
                    node {
                      id
                    }
                    cursor
                  }
                  pageInfo {
                    endCursor
                    hasNextPage
                    hasPreviousPage
                    startCursor
                  }
                }
              }
            }
          `,
          variables: {
            id: tempAccount.id
          }
        })
        .then(
          (query): Account => {
            if (query.data) {
              return query.data.account
            } else {
              throw new Error('Data was empty')
            }
          }
        )
      expect(query.outgoingPayments?.edges).toHaveLength(0)
      expect(query.outgoingPayments?.pageInfo.hasNextPage).toBeFalsy()
      expect(query.outgoingPayments?.pageInfo.hasPreviousPage).toBeFalsy()
      expect(query.outgoingPayments?.pageInfo.startCursor).toBeNull()
      expect(query.outgoingPayments?.pageInfo.endCursor).toBeNull()
    })

    test('pageInfo is correct on pagination from start', async (): Promise<void> => {
      const query = await appContainer.apolloClient
        .query({
          query: gql`
            query Account($id: String!) {
              account(id: $id) {
                outgoingPayments(first: 10) {
                  edges {
                    node {
                      id
                    }
                    cursor
                  }
                  pageInfo {
                    endCursor
                    hasNextPage
                    hasPreviousPage
                    startCursor
                  }
                }
              }
            }
          `,
          variables: {
            id: accountId
          }
        })
        .then(
          (query): Account => {
            if (query.data) {
              return query.data.account
            } else {
              throw new Error('Data was empty')
            }
          }
        )
      expect(query.outgoingPayments?.edges).toHaveLength(10)
      expect(query.outgoingPayments?.pageInfo.hasNextPage).toBeTruthy()
      expect(query.outgoingPayments?.pageInfo.hasPreviousPage).toBeFalsy()
      expect(query.outgoingPayments?.pageInfo.startCursor).toEqual(
        outgoingPayments[0].id
      )
      expect(query.outgoingPayments?.pageInfo.endCursor).toEqual(
        outgoingPayments[9].id
      )
    })

    test('pageInfo is correct on pagination from middle', async (): Promise<void> => {
      const query = await appContainer.apolloClient
        .query({
          query: gql`
            query Account($id: String!, $after: String!) {
              account(id: $id) {
                outgoingPayments(after: $after) {
                  edges {
                    node {
                      id
                    }
                    cursor
                  }
                  pageInfo {
                    endCursor
                    hasNextPage
                    hasPreviousPage
                    startCursor
                  }
                }
              }
            }
          `,
          variables: {
            id: accountId,
            after: outgoingPayments[19].id
          }
        })
        .then(
          (query): Account => {
            if (query.data) {
              return query.data.account
            } else {
              throw new Error('Data was empty')
            }
          }
        )
      expect(query.outgoingPayments?.edges).toHaveLength(20)
      expect(query.outgoingPayments?.pageInfo.hasNextPage).toBeTruthy()
      expect(query.outgoingPayments?.pageInfo.hasPreviousPage).toBeTruthy()
      expect(query.outgoingPayments?.pageInfo.startCursor).toEqual(
        outgoingPayments[20].id
      )
      expect(query.outgoingPayments?.pageInfo.endCursor).toEqual(
        outgoingPayments[39].id
      )
    })

    test('pageInfo is correct on pagination near end', async (): Promise<void> => {
      const query = await appContainer.apolloClient
        .query({
          query: gql`
            query Account($id: String!, $after: String!) {
              account(id: $id) {
                outgoingPayments(after: $after, first: 10) {
                  edges {
                    node {
                      id
                    }
                    cursor
                  }
                  pageInfo {
                    endCursor
                    hasNextPage
                    hasPreviousPage
                    startCursor
                  }
                }
              }
            }
          `,
          variables: {
            id: accountId,
            after: outgoingPayments[44].id
          }
        })
        .then(
          (query): Account => {
            if (query.data) {
              return query.data.account
            } else {
              throw new Error('Data was empty')
            }
          }
        )
      expect(query.outgoingPayments?.edges).toHaveLength(5)
      expect(query.outgoingPayments?.pageInfo.hasNextPage).toBeFalsy()
      expect(query.outgoingPayments?.pageInfo.hasPreviousPage).toBeTruthy()
      expect(query.outgoingPayments?.pageInfo.startCursor).toEqual(
        outgoingPayments[45].id
      )
      expect(query.outgoingPayments?.pageInfo.endCursor).toEqual(
        outgoingPayments[49].id
      )
    })
  })
})