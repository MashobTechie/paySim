import { Module } from '@nestjs/common';

/**
 * Reserved for asynchronous event processing (webhook delivery, retries,
 * scheduled replays). No queue backend is chosen or installed yet.
 */
@Module({})
export class QueuesModule {}
