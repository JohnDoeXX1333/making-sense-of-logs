"""Add a voice-over to demo/out/demo.mp4.

Usage:
  python3 demo/narrate.py                         Microsoft neural voice (edge-tts), free
  python3 demo/narrate.py --engine elevenlabs     ElevenLabs (key in ~/.config/elevenlabs/env as ELEVENLABS_API_KEY)
Writes demo/out/demo_voice.mp4. Each chapter is spoken inside its time window; a chapter that runs long is sped up a
little (edge-tts: up to +15% rate; ElevenLabs: up to 1.12x tempo, generated once to save credits), and the script fails
rather than letting two chapters overlap.
"""
import argparse
import asyncio
import json
import os
import subprocess
import urllib.request
from pathlib import Path

import edge_tts

OUT = Path(__file__).parent / "out"

# (start s, end s, text) on the final video timeline; windows follow the captions written by build.py.
CHAPTERS = [
    (0.2, 4.5, "Making Sense of Logs. One investigation, three perspectives."),
    (4.7, 19.1, "Here are four point seven million log lines from a supercomputer, loaded into SereneDB. "
                "This overview is pure SQL, no AI, and the key takeaways are written from the numbers themselves."),
    (19.4, 46.8, "An engineer asks what happened around the runtime panics on July eleventh. "
                 "The agent picks a few read-only queries, and SereneDB answers them in milliseconds. "
                 "A power-off hit one midplane, and ten seconds later, a hundred and forty-eight nodes panicked. "
                 "The agent is clear that the logs show the order of events, not the cause. "
                 "And every claim opens the real log lines, and the exact SQL behind it."),
    (47.0, 70.0, "Now the team lead. The evidence on the right stays exactly the same; only the explanation changes, "
                 "toward what keeps coming back. When the model uses a number that is not in the evidence, "
                 "the server marks that claim as inferred. The manager gets plain language, "
                 "and a priority score from a visible formula, not an AI guess."),
    (70.3, 79.8, "Ask about customer data loss or cost, and the agent does not make it up. It says the logs cannot tell."),
    (80.1, 103.3, "Anyone can explore the data. Drag across the chart to pick a week, and it is compared with the week before. "
                  "Alert lines are up a hundred and thirty-seven percent, and new alert types appear for the first time. "
                  "Click anything to see the raw lines."),
    (103.7, 125.0, "You can also bring your own logs. This SSH server log is new to the system. "
                   "The model writes a parser from a few lines, and the server tests it on two thousand lines before anything is loaded. "
                   "Every line matched, so SereneDB loads and indexes it."),
    (125.2, 148.8, "The dashboard is ready at once, with the most frequent alert patterns one click away. "
                   "And the same three-role investigation works on the new logs: the evidence arrives first, "
                   "then each view, and every finding cites facts from the new table."),
    (149.2, 165.0, "Every answer shows exactly how it was built. SereneDB finds the facts. The agent explains them, for each role."),
]


def duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


async def speak(text: str, voice: str, rate: int, path: Path):
    await edge_tts.Communicate(text, voice, rate=f"{rate:+d}%").save(str(path))


def eleven_key() -> str:
    if os.environ.get("ELEVENLABS_API_KEY"):
        return os.environ["ELEVENLABS_API_KEY"]
    for line in (Path.home() / ".config/elevenlabs/env").read_text().splitlines():
        if line.startswith("ELEVENLABS_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("ELEVENLABS_API_KEY not found")


def eleven_speak(text: str, voice_id: str, model: str, path: Path):
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128",
        data=json.dumps({"text": text, "model_id": model}).encode(),
        headers={"xi-api-key": eleven_key(), "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        path.write_bytes(r.read())


def tempo(src: Path, factor: float, dst: Path):
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-af", f"atempo={factor:.4f}", str(dst)], check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=["edge", "elevenlabs"], default="edge")
    ap.add_argument("--voice", help="edge-tts voice name or ElevenLabs voice id")
    ap.add_argument("--model", default="eleven_v4", help="ElevenLabs model id")
    args = ap.parse_args()
    clips = []
    for i, (start, end, text) in enumerate(CHAPTERS):
        window = end - start
        if args.engine == "edge":
            voice = args.voice or "en-US-AndrewMultilingualNeural"
            path = OUT / f"vo_{i:02d}.mp3"
            rate = 0
            asyncio.run(speak(text, voice, rate, path))
            d = duration(path)
            while d > window and rate < 15:
                rate += 5
                asyncio.run(speak(text, voice, rate, path))
                d = duration(path)
            how = f"rate {rate:+d}%"
        else:
            voice = args.voice or "cjVigY5qzO86Huf0OWal"  # Eric, smooth and trustworthy
            raw = OUT / f"el_{voice}_{args.model}_{i:02d}.mp3"
            if not raw.exists():  # each chapter is generated once; reruns reuse it and cost no credits
                eleven_speak(text, voice, args.model, raw)
            d = duration(raw)
            path = OUT / f"vo_{i:02d}.mp3"
            factor = max(1.0, d / (window - 0.1))
            if factor > 1.12:
                raise SystemExit(f"chapter {i} needs {d:.1f} s but its window is {window:.1f} s; shorten the text")
            tempo(raw, factor, path)
            d = duration(path)
            how = f"tempo {factor:.2f}x"
        if d > window:
            raise SystemExit(f"chapter {i} needs {d:.1f} s but its window is {window:.1f} s; shorten the text")
        print(f"chapter {i}: {d:5.1f} s of {window:5.1f} s, {how}")
        clips.append((start, path))

    # Place every chapter at its start time, then master the voice to -16 LUFS with -1.5 dBTP headroom.
    inputs, filters = [], []
    for i, (start, path) in enumerate(clips):
        inputs += ["-i", str(path)]
        ms = int(start * 1000)
        filters.append(f"[{i}:a]aresample=48000,adelay={ms}|{ms}[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(clips)))
    total = duration(OUT / "demo.mp4")
    graph = ";".join(filters) + f";{mix}amix=inputs={len(clips)}:normalize=0,apad,atrim=0:{total},loudnorm=I=-16:TP=-1.5:LRA=11[vo]"
    subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", graph, "-map", "[vo]", "-ar", "48000", "-ac", "2",
                    str(OUT / "voice.wav")], check=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(OUT / "demo.mp4"), "-i", str(OUT / "voice.wav"),
                    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
                    "-shortest", "-movflags", "+faststart", str(OUT / "demo_voice.mp4")], check=True)
    print(f"demo_voice.mp4: {duration(OUT / 'demo_voice.mp4'):.1f} s")


if __name__ == "__main__":
    main()
