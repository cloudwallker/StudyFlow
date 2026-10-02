// StudyFlow original implementation. Synthesized PCM; no external audio assets.
using System;
using System.IO;
using System.Media;
using System.Text;

internal static class StudyFlowSound {
    private static int Main(string[] args) {
        int volume;
        if (args.Length != 3 || !Int32.TryParse(args[2], out volume) || volume < 0 || volume > 100) return 2;
        if (args[0] != "cue" && args[0] != "work-end" && args[0] != "break-end" && args[0] != "focus-start" && args[0] != "micro-start" && args[0] != "micro-end" && args[0] != "long-start") return 2;
        if (args[1] != "soft" && args[1] != "bell" && args[1] != "wood") return 2;
        if (volume == 0) return 0;
        try {
            double[] notes = args[0] == "work-end" ? new double[] { 523.25, 659.25, 783.99, 1046.5 }
                : args[0] == "break-end" ? new double[] { 659.25, 783.99, 659.25 }
                : args[0] == "micro-start" || args[0] == "long-start" ? new double[] { 392 }
                : new double[] { 880 };
            const int rate = 44100;
            const double slot = 0.32;
            int count = (int)(rate * slot * notes.Length);
            using (var stream = new MemoryStream()) {
                var writer = new BinaryWriter(stream, Encoding.ASCII);
                writer.Write(Encoding.ASCII.GetBytes("RIFF")); writer.Write(36 + count * 2);
                writer.Write(Encoding.ASCII.GetBytes("WAVEfmt ")); writer.Write(16);
                writer.Write((short)1); writer.Write((short)1); writer.Write(rate); writer.Write(rate * 2);
                writer.Write((short)2); writer.Write((short)16);
                writer.Write(Encoding.ASCII.GetBytes("data")); writer.Write(count * 2);
                for (int i = 0; i < count; i++) {
                    double seconds = (double)i / rate;
                    int index = Math.Min(notes.Length - 1, (int)(seconds / slot));
                    double t = seconds - index * slot;
                    double envelope = Math.Min(1, t / 0.012) * Math.Min(1, (slot - t) / 0.04) * Math.Exp(-t * (args[1] == "wood" ? 22 : 8));
                    double phase = 2 * Math.PI * notes[index] * t;
                    double sample = args[1] == "bell" ? (Math.Sin(phase) + 0.3 * Math.Sin(phase * 2.76)) / 1.3
                        : args[1] == "wood" ? (Math.Sin(phase * 0.5) + 0.2 * Math.Sin(phase * 1.5)) / 1.2 : Math.Sin(phase);
                    writer.Write((short)(sample * envelope * volume / 100.0 * 16000));
                }
                writer.Flush(); stream.Position = 0;
                using (var player = new SoundPlayer(stream)) { player.Load(); player.PlaySync(); }
            }
            return 0;
        } catch { return 1; }
    }
}
