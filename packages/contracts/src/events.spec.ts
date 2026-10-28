import { describe, expect, it } from 'vitest';

import { EventNames, isDocumentIssuedEventV1 } from './events';

describe('DocumentIssuedEventV1', () => {
  it('rechaza eventos sin payload fiscal', () => {
    expect(isDocumentIssuedEventV1({ eventName: EventNames.documentIssued })).toBe(false);
  });

  it('acepta la forma mínima del contrato versionado', () => {
    expect(
      isDocumentIssuedEventV1({
        eventId: '1',
        eventName: EventNames.documentIssued,
        correlationId: 'c-1',
        payload: { documentId: 'd-1', lines: [] },
      }),
    ).toBe(true);
  });
});
