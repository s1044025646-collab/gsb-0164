import { AppError } from '../fir/errors.js';
import { createStreamingState, flush, processBlock, StreamingState } from '../fir/convolution.js';
import { Repository, RunRow } from '../db/repository.js';

/**
 * Streaming run lifecycle. The persisted delay line is the ONLY stream state;
 * restoring it and continuing must match whole-signal processing sample by
 * sample (covered by tests). Sample rate mismatch between signal and filter
 * is rejected here, never silently fixed.
 */
export class RunService {
  constructor(private readonly repo: Repository) {}

  create(filterId: number, signalId: number | null): RunRow {
    const filter = this.repo.getFilter(filterId);
    if (signalId !== null) {
      const signal = this.repo.getSignal(signalId);
      if (signal.sample_rate !== filter.sample_rate) {
        throw new AppError(
          'SAMPLE_RATE_MISMATCH',
          `signal sample rate ${signal.sample_rate} Hz != filter sample rate ${filter.sample_rate} Hz`,
          { signalSampleRate: signal.sample_rate, filterSampleRate: filter.sample_rate },
        );
      }
    }
    return this.repo.createRun(filterId, signalId);
  }

  private restore(runId: number, expectStatus: 'running' | 'paused'): { state: StreamingState; run: RunRow } {
    const run = this.repo.getRun(runId);
    const expected = expectStatus === 'running' ? ['running'] : ['paused'];
    if (run.status === 'flushed') throw new AppError('RUN_FINISHED', `run ${runId} already flushed`);
    if (!expected.includes(run.status)) {
      throw new AppError(
        'RUN_NOT_RUNNING',
        `run ${runId} is '${run.status}'; resume it before processing`,
      );
    }
    const filter = this.repo.getFilter(run.filter_id);
    const coeffs = JSON.parse(filter.coefficients) as number[];
    const state = createStreamingState(coeffs);
    const delay = JSON.parse(run.delay) as number[];
    if (delay.length !== state.delay.length) {
      throw new AppError('VALIDATION_ERROR', 'persisted delay line length does not match filter order');
    }
    state.delay = delay;
    state.samplesIn = run.samples_in;
    state.samplesOut = run.samples_out;
    return { state, run };
  }

  process(runId: number, block: ArrayLike<number>): RunRow {
    const { state } = this.restore(runId, 'running');
    const produced = processBlock(state, block);
    return this.repo.saveRunProgress(runId, new Float64Array(state.delay), produced, block.length);
  }

  pause(runId: number): RunRow {
    this.repo.transitionRun(runId, 'running', 'paused');
    return this.repo.getRun(runId);
  }

  resume(runId: number): RunRow {
    this.repo.transitionRun(runId, 'paused', 'running');
    return this.repo.getRun(runId);
  }

  flushRun(runId: number): RunRow {
    const { state } = this.restore(runId, 'running');
    const tail = flush(state);
    return this.repo.appendTail(runId, tail, new Float64Array(state.delay));
  }

  outputs(runId: number): { outputs: number[]; run: RunRow } {
    const run = this.repo.getRun(runId);
    return { outputs: JSON.parse(run.outputs) as number[], run };
  }
}
