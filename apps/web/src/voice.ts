/**
 * Voice capture for task entry.
 *
 * This uses the browser's own `SpeechRecognition` API rather than bundling a
 * model. That is a deliberate trade with a privacy cost the user must be told
 * about, so the UI discloses it prominently: in Chrome and Edge the audio is sent
 * to the browser vendor's speech service, not processed on this machine. Shipping
 * a local model would mean a tens-of-megabytes download inside a bundle that is
 * currently 60 kB, and it would be worse at Chinese; shipping nothing would mean
 * claiming a feature the platform will not provide.
 *
 * Because availability genuinely varies — Firefox has no implementation, Safari's
 * support is partial, and any browser may have it while offline — everything here
 * is optional. `isSupported()` gates the button, and a missing API hides the
 * control rather than offering a button that does nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

/** The shape the browser exposes, which is not in lib.dom for all of them. */
interface SpeechAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechAlternative;
}

interface SpeechResultList {
  readonly length: number;
  [index: number]: SpeechResult;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechResultList;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
  message?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Whether this browser can listen at all. */
export function isSpeechSupported(): boolean {
  return recognitionCtor() !== null;
}

/**
 * Whether this browser is likely to send audio off the machine.
 *
 * Chromium's implementation streams to a cloud service; Safari's on-device
 * dictation may not. This cannot be detected from script, so the honest answer is
 * "assume yes" — the UI says audio leaves the device, which is true of the
 * browsers this feature actually works in.
 */
export function speechLeavesDevice(): boolean {
  return true;
}

export interface VoiceState {
  supported: boolean;
  listening: boolean;
  /** Accumulated final transcript. */
  transcript: string;
  /** The not-yet-final text, shown greyed so the user sees it is provisional. */
  interim: string;
  error: string | null;
}

export interface VoiceController extends VoiceState {
  start: () => void;
  stop: () => void;
  reset: () => void;
}

/** A human sentence for each error the API can report. */
function describeError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission was refused. Allow it in the browser site settings and try again.';
    case 'no-speech':
      return 'Nothing was heard. Try again closer to the microphone.';
    case 'audio-capture':
      return 'No microphone was found.';
    case 'network':
      return 'The browser could not reach its speech service. It may need a connection.';
    case 'aborted':
      return '';
    default:
      return `Speech recognition failed (${code}).`;
  }
}

/**
 * Hold-to-talk or tap-to-toggle dictation.
 *
 * Continuous mode is deliberately off: a task is one sentence, and leaving the
 * microphone open after the user has finished is exactly the behaviour that makes
 * people distrust voice features.
 */
export function useVoiceInput(locale: string, onFinal: (text: string) => void): VoiceController {
  const supported = isSpeechSupported();
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  // The callback is read through a ref so that changing it does not tear down a
  // session that is mid-sentence.
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const stop = useCallback(() => {
    recognition.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setError('This browser cannot listen.');
      return;
    }
    // Starting a second session while one is live throws in Chromium.
    if (recognition.current) {
      try {
        recognition.current.abort();
      } catch {
        /* already finished */
      }
    }
    setError(null);
    setTranscript('');
    setInterim('');

    const instance = new Ctor();
    instance.lang = locale === 'zh' ? 'zh-CN' : 'en-US';
    instance.continuous = false;
    instance.interimResults = true;
    // One alternative is enough: the parser handles the phrasing, and showing a
    // menu of guesses makes a one-sentence capture feel like a form.
    instance.maxAlternatives = 1;

    instance.onstart = () => setListening(true);
    instance.onend = () => {
      setListening(false);
      setInterim('');
      recognition.current = null;
    };
    instance.onerror = (event) => {
      const message = describeError(event.error);
      if (message) setError(message);
      setListening(false);
    };
    instance.onresult = (event) => {
      let final = '';
      let pending = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const alternative = result[0];
        if (!alternative) continue;
        if (result.isFinal) final += alternative.transcript;
        else pending += alternative.transcript;
      }
      if (pending) setInterim(pending);
      if (final) {
        setTranscript((current) => current + final);
        // Hand the text to the caller as soon as it is final, so the user sees the
        // parse preview while the session is still winding down.
        onFinalRef.current(final);
      }
    };

    recognition.current = instance;
    try {
      instance.start();
    } catch (thrown) {
      recognition.current = null;
      setError(`Could not start listening: ${(thrown as Error).message}`);
    }
  }, [locale]);

  const reset = useCallback(() => {
    setTranscript('');
    setInterim('');
    setError(null);
  }, []);

  // Leaving the page must not leave the microphone open.
  useEffect(
    () => () => {
      try {
        recognition.current?.abort();
      } catch {
        /* nothing to abort */
      }
    },
    [],
  );

  return { supported, listening, transcript, interim, error, start, stop, reset };
}
