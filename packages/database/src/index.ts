import { randomUUID } from "node:crypto";

export interface TransactionClient {
  query(statement: string, values?: readonly unknown[]): Promise<unknown>;
}

export const newEntityId = (): string => randomUUID();

export const toUtcTimestamp = (value: Date = new Date()): string => {
  if (Number.isNaN(value.getTime())) throw new Error("timestamp must be a valid date");
  return value.toISOString();
};

export const withTransaction = async <T>(
  client: TransactionClient,
  operation: (transaction: TransactionClient) => Promise<T>,
): Promise<T> => {
  await client.query("BEGIN");
  try {
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "transaction and rollback both failed");
    }
    throw error;
  }
};
export * from "./project-catalog.js";
export * from "./project-buckets.js";
export * from "./agent-identities.js";
export * from "./agent-project-assignments.js";


export * from "./audit-events.js";


export * from "./transactional-events.js";
