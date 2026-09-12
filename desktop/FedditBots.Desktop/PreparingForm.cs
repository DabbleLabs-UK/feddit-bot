using System.Drawing;
using System.Windows.Forms;

namespace DabbleLabs.FedditBots.Desktop;

internal sealed class PreparingForm : Form
{
    private readonly Label _message;

    public PreparingForm()
    {
        Text = "Feddit Bots";
        Width = 470;
        Height = 155;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ControlBox = false;

        _message = new Label
        {
            Left = 24,
            Top = 22,
            Width = 410,
            Height = 42,
            Text = "Preparing Feddit Bots...",
            Font = new Font((SystemFonts.MessageBoxFont ?? SystemFonts.DefaultFont).FontFamily, 10),
        };
        var progress = new ProgressBar
        {
            Left = 24,
            Top = 76,
            Width = 410,
            Height = 18,
            Style = ProgressBarStyle.Marquee,
            MarqueeAnimationSpeed = 25,
        };
        Controls.Add(_message);
        Controls.Add(progress);
    }

    public void SetMessage(string message)
    {
        _message.Text = message;
        Application.DoEvents();
    }
}
