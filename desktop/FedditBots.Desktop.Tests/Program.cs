using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using DabbleLabs.FedditBots.Desktop;

var checks = 0;
void Check(bool condition, string message)
{
    if (!condition) throw new Exception("FAIL: " + message);
    checks++;
}

Check(LaunchIntent.ShouldOpenInterface(["--open-ui"]), "an explicit shortcut launch opens the interface");
Check(LaunchIntent.ShouldOpenInterface(["--OPEN-UI"]), "the open-interface argument is case insensitive");
Check(!LaunchIntent.ShouldOpenInterface([]), "a background restart does not open a browser");
Check(!LaunchIntent.ShouldOpenInterface(["--background"]), "Windows login startup does not open a browser");

using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
var unsigned = new UpdateManifest
{
    Version = "1.2.0",
    PackageUrl = "feddit-bots-1.2.0.zip",
    Sha256 = new string('a', 64),
    Signature = "pending",
    MinLauncherVersion = "0.1.0",
    PublishedAt = "2026-09-12T12:00:00Z",
};
var signature = key.SignData(
    Encoding.UTF8.GetBytes(unsigned.CanonicalText),
    HashAlgorithmName.SHA256,
    DSASignatureFormat.Rfc3279DerSequence);
var signed = unsigned with { Signature = Convert.ToBase64String(signature) };
UpdateSecurity.ValidateManifest(signed, key.ExportSubjectPublicKeyInfoPem(), "0.1.0");
Check(true, "a correctly signed manifest is accepted");

try
{
    UpdateSecurity.ValidateManifest(signed with { Version = "1.3.0" }, key.ExportSubjectPublicKeyInfoPem(), "0.1.0");
    Check(false, "tampering must fail");
}
catch (InvalidDataException)
{
    Check(true, "tampering invalidates the signature");
}

Check(UpdateSecurity.CompareVersions("1.10.0", "1.9.9") > 0, "numeric versions compare correctly");

var temp = Path.Combine(Path.GetTempPath(), "feddit-bots-update-test-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(temp);
try
{
    var unsafeZip = Path.Combine(temp, "unsafe.zip");
    using (var archive = ZipFile.Open(unsafeZip, ZipArchiveMode.Create))
        archive.CreateEntry("../outside.txt");
    try
    {
        UpdateService.ExtractSafely(unsafeZip, Path.Combine(temp, "out"));
        Check(false, "zip traversal must fail");
    }
    catch (InvalidDataException)
    {
        Check(true, "zip traversal is rejected");
    }

    var safeZip = Path.Combine(temp, "safe.zip");
    using (var archive = ZipFile.Open(safeZip, ZipArchiveMode.Create))
    {
        var entry = archive.CreateEntry("app/server.js");
        using var writer = new StreamWriter(entry.Open());
        writer.Write("'use strict';");
    }
    var safeOut = Path.Combine(temp, "safe-out");
    UpdateService.ExtractSafely(safeZip, safeOut);
    Check(UpdateService.PayloadIsComplete(safeOut), "a valid app payload is accepted");
}
finally
{
    Directory.Delete(temp, true);
}

Console.WriteLine("desktop updater: " + checks + " checks passed");
