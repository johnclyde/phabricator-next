# Local transcription fixture

`jfk.wav` is the 11-second, mono 16 kHz PCM sample distributed by
[whisper.cpp](https://github.com/ggml-org/whisper.cpp/tree/7e26d3b0d5bced6c8217ef09710ec2f969001241/samples).
It contains an excerpt of President John F. Kennedy's 1961 inaugural address,
a United States government speech in the public domain.

Source: `https://raw.githubusercontent.com/ggml-org/whisper.cpp/7e26d3b0d5bced6c8217ef09710ec2f969001241/samples/jfk.wav`

SHA-256: `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`

The real-runtime browser test uses these exact bytes as a saved audio clip. It
checks recognizable words, offline processing, provenance and lifecycle behavior;
it is not a broad transcription-accuracy or physical-microphone evaluation.
The fixture is public test data and never comes from a user's recording.
