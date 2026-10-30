import { Module } from '@nestjs/common';
import { STATE_MACHINE_PACKAGE } from '@paysim/state-machine';

/**
 * State machine: the API-side home of validated payment state transitions.
 * Transition rules will live in @paysim/state-machine; this module will expose them
 * to the payments module so no state change bypasses validation.
 *
 * Foundation only — no business logic implemented yet.
 */
@Module({
  providers: [{ provide: 'STATE_MACHINE_PACKAGE', useValue: STATE_MACHINE_PACKAGE }],
})
export class StateMachineModule {}
