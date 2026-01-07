import { randomUUID } from 'crypto';

export interface IdGenerator {
  newThreadId(): string;
  newCommentId(): string;
}

export class UuidIdGenerator implements IdGenerator {
  newThreadId(): string {
    return randomUUID();
  }

  newCommentId(): string {
    return randomUUID();
  }
}

