import { designFilter, DesignParams, DesignedFilter } from '../fir/design.js';
import { Repository } from '../db/repository.js';

export class FilterService {
  constructor(private readonly repo: Repository) {}

 design(params: DesignParams, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = this.repo.findFilterByIdempotencyKey(idempotencyKey);
      if (existing) return { filter: existing, designed: this.rowToFilter(existing), replayed: true };
    }
    const designed = designFilter(params);
    const filter = this.repo.insertFilter({
      type: params.type,
      sampleRate: params.sampleRate,
      cutoffHz: params.cutoffHz,
      length: params.length,
      window: params.window,
      coefficients: designed.coefficients,
      dcGain: designed.dcGain,
      nyquistGain: designed.nyquistGain,
      idempotencyKey,
    });
    return { filter, designed, replayed: false };
  }

  rowToFilter(row: { coefficients: string }): DesignedFilter {
    const coeffs = new Float64Array(JSON.parse(row.coefficients) as number[]);
    return {
      params: {
        type: 'lowpass',
        sampleRate: 0,
        cutoffHz: 0,
        length: coeffs.length,
        window: 'rectangular',
      },
      coefficients: coeffs,
      center: (coeffs.length - 1) / 2,
      normalizedCutoff: NaN,
      dcGain: NaN,
      nyquistGain: NaN,
      dcScale: NaN,
      nyquistScale: NaN,
    };
  }
}
