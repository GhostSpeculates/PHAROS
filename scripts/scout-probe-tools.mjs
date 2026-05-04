#!/usr/bin/env node
// Phase 2.5 Tier 1 verification — tool_use end-to-end through /v1/messages.
// Tests the EXACT wire protocol Claude Agent SDK uses internally (base SDK
// messages.stream + tools = same HTTP/SSE shape as claude-agent-sdk).
//
// Two phases: non-streaming with tools, then streaming with tools.
// In both phases the model is given a tool definition it MUST call to
// answer the user's question (the question can't be answered without it).

import Anthropic from '@anthropic-ai/sdk';

const baseURL = process.env.PHAROS_URL || 'http://localhost:3777';
const apiKey = process.env.PHAROS_API_KEY;

if (!apiKey) {
    console.error('✗ Set PHAROS_API_KEY env var');
    process.exit(1);
}

const client = new Anthropic({ baseURL, apiKey });

console.log(`→ Probing Pharos /v1/messages with tools at ${baseURL}\n`);

// A tool the model can't avoid calling — its definition is the only way
// to answer "what's the weather in NYC?"
const tool = {
    name: 'get_weather',
    description: 'Get the current weather for a city. Returns temperature in Fahrenheit and conditions.',
    input_schema: {
        type: 'object',
        properties: {
            city: { type: 'string', description: 'City name, e.g. "New York"' },
        },
        required: ['city'],
    },
};

// ─── Phase 1: non-streaming + tools ───
console.log('[1/2] Non-streaming + tools');
try {
    const r = await client.messages.create({
        model: 'pharos-auto:scout',
        max_tokens: 200,
        tools: [tool],
        messages: [{ role: 'user', content: "What's the weather in New York?" }],
    });

    const toolUseBlock = r.content.find((b) => b.type === 'tool_use');
    if (!toolUseBlock) {
        console.error('  ✗ FAILED — no tool_use block in response');
        console.error('  Content:', JSON.stringify(r.content, null, 2));
        console.error('  Stop reason:', r.stop_reason);
        process.exit(2);
    }

    console.log('  ✓ Tool call fired');
    console.log('    name:    ', toolUseBlock.name);
    console.log('    id:      ', toolUseBlock.id);
    console.log('    input:   ', JSON.stringify(toolUseBlock.input));
    console.log('  ✓ Stop reason:', r.stop_reason);
    console.log('  ✓ Usage:      ', JSON.stringify(r.usage));

    // Follow-up: send tool_result back, get final text answer
    console.log('\n  → Sending tool_result back to complete the loop...');
    const followup = await client.messages.create({
        model: 'pharos-auto:scout',
        max_tokens: 200,
        tools: [tool],
        messages: [
            { role: 'user', content: "What's the weather in New York?" },
            { role: 'assistant', content: r.content },
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: toolUseBlock.id,
                        content: '72°F, sunny',
                    },
                ],
            },
        ],
    });

    const finalText = followup.content.find((b) => b.type === 'text');
    if (!finalText) {
        console.error('  ✗ FAILED — no text response after tool_result');
        process.exit(2);
    }
    console.log('  ✓ Final text response:', finalText.text);
    console.log('  ✓ Stop reason:        ', followup.stop_reason);
} catch (e) {
    console.error('  ✗ FAILED:', e.message);
    if (e.status) console.error('  HTTP:', e.status);
    if (e.error) console.error('  Body:', JSON.stringify(e.error));
    process.exit(2);
}

// ─── Phase 2: streaming + tools ───
console.log('\n[2/2] Streaming + tools');
try {
    const stream = client.messages.stream({
        model: 'pharos-auto:scout',
        max_tokens: 200,
        tools: [tool],
        messages: [{ role: 'user', content: "What's the weather in New York?" }],
    });

    const eventTypes = [];
    let toolUseStarted = false;
    let toolUseName = null;
    let toolUseId = null;
    const argFragments = [];

    for await (const event of stream) {
        eventTypes.push(event.type);
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            toolUseStarted = true;
            toolUseName = event.content_block.name;
            toolUseId = event.content_block.id;
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
            argFragments.push(event.delta.partial_json);
        }
    }

    const final = await stream.finalMessage();

    if (!toolUseStarted) {
        console.error('  ✗ FAILED — no tool_use content_block_start event');
        console.error('  Events:', eventTypes.join(' → '));
        process.exit(3);
    }

    const reassembledArgs = argFragments.join('');
    console.log('  ✓ Stream completed');
    console.log('  ✓ Event sequence: ', eventTypes.join(' → '));
    console.log('  ✓ Tool name:      ', toolUseName);
    console.log('  ✓ Tool id:        ', toolUseId);
    console.log('  ✓ Reassembled args:', reassembledArgs);
    console.log('  ✓ Final stop_reason:', final.stop_reason);
    console.log('  ✓ Final usage:    ', JSON.stringify(final.usage));

    // Verify args parse to valid JSON
    try {
        const parsed = JSON.parse(reassembledArgs);
        console.log('  ✓ Parsed args:    ', JSON.stringify(parsed));
    } catch (e) {
        console.error('  ⚠ Reassembled args are not valid JSON:', e.message);
    }

    // Sanity checks on event order
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

console.log('\n✓ Phase 2.5 Tier 1 verified — tool_use works end-to-end via /v1/messages.');
console.log('  Both non-streaming and streaming paths confirmed against a real provider.');
