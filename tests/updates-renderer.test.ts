import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { createServer } from 'vite';
import { act, createElement as h } from 'react';
import { within, fireEvent } from '@testing-library/dom';

;
