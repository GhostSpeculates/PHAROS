#!/usr/bin/env node
// Scout activation probe — verifies Claude Agent SDK can talk to Pharos
// via the /v1/messages endpoint. Two phases: non-streaming, then streaming.

import Anthropic from '@anthropic-ai/sdk';

const baseURL = process.env.PHAROS_URL || 'http://localhost:3777';
const apiKey = process.env.PHAROS_API_KEY;

if (!apiKey) {
    console.error('✗ Set PHAROS_API_KEY env var (operator or wallet key)');
    process.exit(1);
}

const client = new Anthropic({ baseURL, apiKey });

console.log(`→ Probing Pharos at ${baseURL}`);

// ─── Phase 1: non-streaming ───
console.log('\n[1/2] Non-streaming text request');
try {
    const r = await client.messages.create({
        model: 'pharos-auto:scout',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Say hi in 5 words' }],
    });
    console.log('  ✓ Status: success');
    console.log('  Response id:    ', r.id);
    console.log('  Stop reason:    ', r.stop_reason);
    console.log('  Model echoed:   ', r.model);
    console.log('  Usage:          ', JSON.stringify(r.usage));
    console.log('  Content[0]:     ', JSON.stringify(r.content[0]));
} catch (e) {
    console.error('  ✗ FAILED:', e.message);
    if (e.status) console.error('  HTTP:', e.status);
    if (e.error) console.error('  Body:', JSON.stringify(e.error));
    process.exit(2);
}

// ─── Phase 2: streaming ───
console.log('\n[2/2] Streaming text request');
try {
    const stream = await client.messages.stream({
        model: 'pharos-auto:scout',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Count to three slowly.' }],
    });

    const eventTypes = [];
    for await (const event of stream) {
        eventTypes.push(event.type);
    }

    const final = await stream.finalMessage();
    console.log('  ✓ Stream completed');
    console.log('  Event sequence: ', eventTypes.join(' → '));
    console.log('  Final stop_reason:', final.stop_reason);
    console.log('  Final content:  ', JSON.stringify(final.content));
    console.log('  Final usage:    ', JSON.stringify(final.usage));

    // Sanity: should start with message_start, end with message_stop
    if (eventTypes[0] !== 'message_start') {
        console.error('  ⚠ First event is not message_start');
    }
    if (eventTypes[eventTypes.length - 1] !== 'message_stop') {
        console.error('  ⚠ Last event is not message_stop');
    }
} catch (e) {
    console.error('  ✗ FAILED:', e.message);
    if (e.status) console.error('  HTTP:', e.status);
    if (e.error) console.error('  Body:', JSON.stringify(e.error));
    process.exit(3);
}

console.log('\n✓ Scout activated — Pharos /v1/messages endpoint working end-to-end.');
