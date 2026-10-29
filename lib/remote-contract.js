/** Shared strict Remote contract. Embedded in the browser by scripts/build-client-sync.mjs. */
export function createRemoteContract() {
  const boundedString = (value, max) => {
    if (typeof value !== 'string' || value.length > max) throw new TypeError('Invalid state subscription');
    return value;
  };
  const codec = (name, parse) => ({ mode: 'strict', typeSymbol: `persona-shell#${name}`, create: () => ({ parse }) });
  const session = codec('SessionKey', (value) => boundedString(value, 200));
  const view = codec('ViewLease', (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !['viewer', 'revision', 'visible'].includes(key))
      || typeof value.visible !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 0
      || boundedString(value.viewer, 100) === '') throw new TypeError('Invalid view lease');
    return value;
  });
  const frame = codec('StateFrame', (value) => {
    if (!value || !['snapshot', 'delta'].includes(value.type)
      || typeof value.instanceId !== 'string' || !value.instanceId
      || !Number.isSafeInteger(value.rev) || value.rev < 0) throw new TypeError('Invalid state frame');
    return value;
  });
  return {
    package: 'dsh-persona-shell',
    descriptors: [{
      id: 'dsh-persona-shell#personaShell/observe', service: 'personaShell', namespace: 'personaShell',
      method: 'observe', mode: 'stream', invocation: { kind: 'direct' },
      parameters: [{ name: 'key', wire: 'key', source: 'json', codec: session }],
      cancellation: { parameter: 'signal' }, uplink: { codec: view }, result: frame,
    }],
  };
}
