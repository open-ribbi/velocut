# @velocut/provider-minimax

Velocut's existing MiniMax T2A HTTP adapter, independently packaged. Depends only
on `@velocut/provider-sdk`. It returns encoded MP3 bytes and never constructs an
AudioContext, decodes audio, stores a file or edits a timeline.

Register `minimaxProvider` with `ProviderRegistry`. Configure optional endpoint,
groupId, model and voice; put an API key in the declared `apiKey` credential slot.
For the existing Studio development proxy, credentials may be injected by that
proxy, so this slot is optional. A production host must provide a working endpoint
and authentication. No proxy is installed by this package.

The `audio.synthesize` request has `{text, voice?, speed?}` and an explicitly
selected configured model. Model/service input checks run before credentials or
network access. `execute` performs one request; malformed hex audio, nonzero
service status and HTTP errors fail visibly. No automatic retry, fallback or
remote cancellation is implied. Existing `MiniMaxTextToSpeech` in render-sdk
uses this adapter, then decodes the bytes in its browser audio layer.

Defaults retain the existing Studio behavior (`speech-2.8-hd`, MP3/32 kHz,
`male-qn-jingying`). Model availability remains a service/account concern.
Wire reference: [MiniMax HTTP speech API](https://platform.minimax.io/docs/api-reference/speech-t2a-http).
This source/local package is not yet published to npm.
