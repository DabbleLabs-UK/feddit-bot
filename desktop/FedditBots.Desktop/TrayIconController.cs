using System.ComponentModel;
using System.Drawing;
using System.Windows.Forms;

namespace DabbleLabs.FedditBots.Desktop;

internal sealed class TrayIconController : IDisposable
{
    internal const string OpenMenuText = "Open bot dashboard";
    internal const string ExitMenuText = "Exit Feddit Bots";

    private readonly Thread _thread;
    private readonly ManualResetEventSlim _started = new(false);
    private SynchronizationContext? _uiContext;
    private TrayApplicationContext? _applicationContext;
    private Exception? _startupError;
    private int _disposed;

    public TrayIconController(Action openDashboard, Action exitApplication)
    {
        ArgumentNullException.ThrowIfNull(openDashboard);
        ArgumentNullException.ThrowIfNull(exitApplication);

        _thread = new Thread(() => Run(openDashboard, exitApplication))
        {
            IsBackground = true,
            Name = "Feddit Bots notification area",
        };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
        _started.Wait();

        if (_startupError is not null)
        {
            throw new InvalidOperationException("The Feddit Bots notification-area menu could not start.", _startupError);
        }
    }

    private void Run(Action openDashboard, Action exitApplication)
    {
        try
        {
            _uiContext = new WindowsFormsSynchronizationContext();
            SynchronizationContext.SetSynchronizationContext(_uiContext);
            _applicationContext = new TrayApplicationContext(openDashboard, exitApplication);
            _started.Set();
            Application.Run(_applicationContext);
            _applicationContext = null;
        }
        catch (Exception error)
        {
            _startupError = error;
            _started.Set();
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;

        var context = _applicationContext;
        var uiContext = _uiContext;
        if (context is not null && uiContext is not null)
        {
            try
            {
                uiContext.Post(_ => context.ExitThread(), null);
            }
            catch (InvalidAsynchronousStateException)
            {
                // The user chose Exit from the menu and its message loop has
                // already ended. There is nothing left to marshal onto.
            }
        }
        if (Thread.CurrentThread != _thread)
        {
            _thread.Join(TimeSpan.FromSeconds(5));
        }
        _started.Dispose();
    }

    private sealed class TrayApplicationContext : ApplicationContext
    {
        private readonly NotifyIcon _icon;
        private readonly ContextMenuStrip _menu;

        public TrayApplicationContext(Action openDashboard, Action exitApplication)
        {
            _menu = new ContextMenuStrip();
            var openItem = new ToolStripMenuItem(OpenMenuText);
            var exitItem = new ToolStripMenuItem(ExitMenuText);
            openItem.Click += (_, _) => TryOpen(openDashboard);
            exitItem.Click += (_, _) =>
            {
                exitApplication();
                ExitThread();
            };
            _menu.Items.Add(openItem);
            _menu.Items.Add(new ToolStripSeparator());
            _menu.Items.Add(exitItem);

            _icon = new NotifyIcon
            {
                ContextMenuStrip = _menu,
                Icon = SystemIcons.Application,
                Text = "Feddit Bots",
                Visible = true,
            };
            _icon.DoubleClick += (_, _) => TryOpen(openDashboard);
        }

        private static void TryOpen(Action openDashboard)
        {
            try
            {
                openDashboard();
            }
            catch (Exception error)
            {
                MessageBox.Show(
                    "The bot dashboard could not be opened.\n\n" + error.Message,
                    "Feddit Bots",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }

        protected override void ExitThreadCore()
        {
            _icon.Visible = false;
            _icon.Dispose();
            _menu.Dispose();
            base.ExitThreadCore();
        }
    }
}
