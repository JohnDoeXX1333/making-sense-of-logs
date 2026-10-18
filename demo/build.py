"""Assemble the demo video from the Playwright recordings in demo/out.

Usage: python3 demo/build.py   ->  demo/out/demo.mp4 (1920x1080, 30 fps, H.264, BT.709, burned-in English captions)
Waiting time (format detection, loading, the live model call) is sped up and labelled on screen.
"""
import json
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).parent / "out"
FPS = 30
ENC = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS),
       "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-threads", "4"]

# Each scene: segments of the source recording as (start, end, speed); captions as (start, end, text) in source
# seconds; marker names are resolved from <scene>.json.
SCENES = {
    "overview": {
        "segments": [(0.4, "end", 1)],
        "captions": [
            (0.4, "chart", "4.7 million supercomputer log lines in SereneDB"),
            ("chart", "takeaways", "The overview is pure SQL, no AI"),
            ("takeaways", "end", "Takeaways in plain words, computed from the data"),
        ],
    },
    "investigate": {
        "segments": [(0.8, "end", 1)],
        "captions": [
            (0.8, "answer", "Engineer: what happened around the runtime panics?"),
            ("answer", 9.5, "A power-off on midplane R05-M0"),
            (9.5, "unknowns", "Ten seconds later, 148 nodes panic"),
            ("unknowns", "evidence", "The logs show the order, not the cause"),
            ("evidence", "teamlead", "Every claim opens the real log lines and the SQL"),
            ("teamlead", "inferred", "Team lead: same evidence, focus on what recurs"),
            ("inferred", "manager", "A number not in the evidence is marked inferred"),
            ("manager", 46.5, "Manager: plain language and priorities"),
            (46.5, "end", "The score is a visible formula, not an AI guess"),
        ],
    },
    "unknown": {
        "segments": [(0.5, "end", 1)],
        "captions": [
            (0.5, "answer", "Did the panics cause data loss? What did it cost?"),
            ("answer", "end", "The agent says the logs cannot tell"),
        ],
    },
    "insights": {
        "segments": [(0.3, "end", 1)],
        "captions": [
            (0.3, "kpis", "Drag across the chart to pick a period"),
            ("kpis", "takeaways", "Compared with the week before: alert lines up 137%"),
            ("takeaways", "changed", "Alert types seen for the first time this week"),
            ("changed", "end", "Click anything to see the raw lines"),
        ],
    },
    "upload": {
        "segments": [
            (0.5, "detect", 1), ("detect", "detected", 4), ("detected", "load", 1), ("load", "loaded", 4),
            ("loaded", "ask", 1), ("ask", "first_view", 10), ("first_view", 103.2, 1), (103.2, "all_views", 8),
            ("all_views", "end", 1),
        ],
        "captions": [
            (0.5, "detect", "Bring your own logs: an SSH server log it has never seen"),
            ("detect", "detected", "The model writes a parser, the server tests it on 2,000 lines"),
            ("detected", "load", "100% of lines matched; check the preview, then load"),
            ("load", "loaded", "SereneDB loads and indexes it in seconds"),
            ("loaded", "patterns", "An instant dashboard for the new data"),
            ("patterns", 54.4, "The most frequent alert patterns, one click to the lines"),
            (54.4, "first_view", "The same three-role investigation on the new logs"),
            ("first_view", "all_views", "Evidence first, then each role view as it is written"),
            ("all_views", "trace", "Findings cite facts from the new table"),
            ("trace", "end", "Every answer shows how it was built"),
        ],
    },
}
ORDER = ["overview", "investigate", "unknown", "insights", "upload"]
TITLE_S = 4.0
END_S = 5.0

CARD_CSS = """
html,body{margin:0;width:1920px;height:1080px;background:#08090a;color:#f2f2f3;font-family:Inter,'Segoe UI',Roboto,'Noto Sans',Arial,sans-serif;}
.wrap{position:absolute;left:220px;right:220px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:28px;}
h1{font-size:104px;line-height:1;letter-spacing:-0.035em;font-weight:600;margin:0;}
p{font-size:44px;line-height:1.25;color:#b4b6bc;margin:0;font-weight:400;letter-spacing:-0.01em;}
.bar{width:120px;height:6px;background:#3987e5;border-radius:3px;}
small{position:absolute;left:220px;bottom:110px;font-size:28px;color:#8a8f98;letter-spacing:0.01em;}
"""
TITLE_HTML = f"""<html><head><style>{CARD_CSS}</style></head><body><div class="wrap"><div class="bar"></div>
<h1>Making Sense of Logs</h1><p>One investigation, three perspectives</p></div>
<small>SereneDB 26.10.1 &middot; DeepSeek V4.1 Flash &middot; National AI Hackathon 2026</small></body></html>"""
END_HTML = f"""<html><head><style>{CARD_CSS}</style></head><body><div class="wrap"><div class="bar"></div>
<h1>SereneDB finds the facts.</h1><p>The agent explains them for each role, and every claim links to its evidence.</p></div>
<small>Loghub BGL, 4,747,963 lines &middot; plus any log file you upload</small></body></html>"""


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def render_cards():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        page = b.new_page(viewport={"width": 1920, "height": 1080})
        for name, html in (("title", TITLE_HTML), ("end", END_HTML)):
            page.set_content(html)
            page.wait_for_timeout(300)
            page.screenshot(path=str(OUT / f"{name}.png"))
        b.close()


def card_clip(name, seconds, fade_in, fade_out):
    vf = f"fps={FPS},format=yuv420p" + (f",fade=t=in:st=0:d={fade_in}" if fade_in else "") + (f",fade=t=out:st={seconds - fade_out}:d={fade_out}" if fade_out else "")
    run(["ffmpeg", "-y", "-loop", "1", "-t", str(seconds), "-i", str(OUT / f"{name}.png"), "-vf", vf, *ENC, str(OUT / f"clip_{name}.mp4")])


def resolve(v, markers, end):
    if v == "end":
        return end
    return markers[v] if isinstance(v, str) else float(v)


def scene_clip(name):
    src = OUT / f"{name}.webm"
    markers = json.loads((OUT / f"{name}.json").read_text())
    end = min(duration(src), markers.get("end", 1e9))
    segs = [(resolve(a, markers, end), resolve(b, markers, end), sp) for a, b, sp in SCENES[name]["segments"]]
    parts, labels = [], []
    for i, (a, b, sp) in enumerate(segs):
        parts.append(f"[0:v]trim={a:.3f}:{b:.3f},setpts=(PTS-STARTPTS)/{sp},fps={FPS},scale=1920:1080,setsar=1[v{i}]")
        labels.append(f"[v{i}]")
    graph = ";".join(parts) + f";{''.join(labels)}concat=n={len(segs)}:v=1:a=0[out]"
    run(["ffmpeg", "-y", "-i", str(src), "-filter_complex", graph, "-map", "[out]", *ENC, str(OUT / f"clip_{name}.mp4")])

    # Map source time to clip time through the segments, for captions and speed labels.
    def to_clip(t):
        acc = 0.0
        for a, b, sp in segs:
            if t <= b:
                return acc + max(0.0, t - a) / sp
            acc += (b - a) / sp
        return acc

    captions = [(to_clip(resolve(a, markers, end)), to_clip(resolve(b, markers, end)), text) for a, b, text in SCENES[name]["captions"]]
    speed = [(to_clip(a), to_clip(b), f"Sped up {sp}x") for a, b, sp in segs if sp != 1]
    return captions, speed


def ts(t):
    h, rem = divmod(max(0.0, t), 3600)
    m, s = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def write_ass(events):
    head = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Noto Sans,46,&H00FFFFFF,&H00FFFFFF,&H28111111,&H28111111,1,0,0,0,100,100,0,0,3,18,0,2,160,160,70,1
Style: Speed,Noto Sans,30,&H00F2F2F2,&H00F2F2F2,&H40111111,&H40111111,1,0,0,0,100,100,0,0,3,10,0,9,60,60,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [f"Dialogue: 0,{ts(a)},{ts(b - 0.05)},{style},,0,0,0,,{text}" for a, b, style, text in events if b - a > 0.3]
    (OUT / "captions.ass").write_text(head + "\n".join(lines) + "\n")


def main():
    render_cards()
    card_clip("title", TITLE_S, 0.6, 0)
    card_clip("end", END_S, 0, 0.8)
    events, offset = [], TITLE_S
    for name in ORDER:
        captions, speed = scene_clip(name)
        events += [(offset + a, offset + b, "Cap", t) for a, b, t in captions]
        events += [(offset + a, offset + b, "Speed", t) for a, b, t in speed]
        offset += duration(OUT / f"clip_{name}.mp4")
        print(f"{name}: ends at {offset:.1f} s")
    write_ass(events)
    clips = ["title", *ORDER, "end"]
    (OUT / "clips.txt").write_text("".join(f"file 'clip_{c}.mp4'\n" for c in clips))
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(OUT / "clips.txt"), "-c", "copy", str(OUT / "body.mp4")])
    run(["ffmpeg", "-y", "-i", str(OUT / "body.mp4"), "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
         # ffmpeg 7.1+ takes colour tags from the frames, so set BT.709 on the frames as well as on the stream.
         "-vf", f"subtitles={OUT / 'captions.ass'},scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
         *ENC, "-color_range", "tv", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", str(OUT / "demo.mp4")])
    print(f"demo.mp4: {duration(OUT / 'demo.mp4'):.1f} s")


if __name__ == "__main__":
    main()
