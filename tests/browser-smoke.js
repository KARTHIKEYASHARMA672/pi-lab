async (page) => {
  const passed = [],
    errors = [];
  const check = (ok, label) => {
    if (!ok) throw Error(label);
    passed.push(label);
  };
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:4180");
  await page.setViewportSize({ width: 1365, height: 900 });
  await page
    .getByRole("button", { name: "Double-click to boot virtual Raspberry Pi" })
    .dblclick();
  await page
    .getByRole("heading", { name: "A little computer. Real execution." })
    .waitFor();
  await page.getByText("LINUX CONNECTED", { exact: true }).waitFor();
  check(true, "Board double-click boots connected Linux desktop");
  await page.screenshot({ path: "screenshots/desktop.png" });
  await page.locator('.desktop-icons [data-open="editor"]').click();
  const editor = page.getByRole("region", {
    name: "Python Editor",
    exact: true,
  });
  const source = editor.getByRole("textbox", { name: "Python source code" });
  await source.fill(
    'import platform\nname = input("Your name: ")\nprint("Hello", name)\nprint("System:", platform.system())\nprint("Result:", 6 * 7)',
  );
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Saved to Linux:" })
    .waitFor();
  await editor.getByRole("button", { name: "▶ Run", exact: true }).click();
  const output = editor.locator(".output-text");
  await output.filter({ hasText: "Your name:" }).waitFor();
  await editor
    .getByRole("textbox", { name: "Python program input" })
    .fill("Student");
  await editor
    .getByRole("textbox", { name: "Python program input" })
    .press("Enter");
  await output.filter({ hasText: "Process exited with code 0." }).waitFor();
  check(
    (await output.innerText()).includes("Hello Student"),
    "Python editor supports real stdin",
  );
  check(
    (await output.innerText()).includes("System: Linux"),
    "Editor executes CPython on Linux",
  );
  check(
    (await output.innerText()).includes("Result: 42"),
    "Editor reports computed result",
  );
  await page.screenshot({ path: "screenshots/python-editor.png" });
  await editor.getByRole("button", { name: "Maximize", exact: true }).click();
  check(
    (await editor.getAttribute("class")).includes("maximized"),
    "Maximize window",
  );
  await editor.getByRole("button", { name: "Maximize", exact: true }).click();
  await editor.getByRole("button", { name: "Minimize", exact: true }).click();
  check(await editor.isHidden(), "Minimize window");
  await page
    .locator("#tasks")
    .getByRole("button", { name: "Python Editor", exact: true })
    .click();
  check(await editor.isVisible(), "Restore minimized window");
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByTitle("Terminal", { exact: true }).click();
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  await terminal
    .getByText("Real Bash · Debian Linux · isolated container", { exact: true })
    .waitFor();
  const input = terminal.locator(".xterm-helper-textarea");
  await input.focus();
  await page.keyboard.type('python3 -c "print(7 * 8)"');
  await page.keyboard.press("Enter");
  // Execution is checked by runtime_smoke.py; verify the canvas terminal renders here.
  await page.waitForTimeout(500);
  await page.screenshot({ path: "screenshots/terminal.png" });
  check(
    await terminal.locator(".xterm-screen").isVisible(),
    "Real interactive terminal is rendered",
  );
  await terminal.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByTitle("File Manager", { exact: true }).click();
  const manager = page.getByRole("region", {
    name: "File Manager",
    exact: true,
  });
  await manager.locator(".file-item").filter({ hasText: "Python" }).dblclick();
  await manager
    .locator(".file-item")
    .filter({ hasText: "hello.py" })
    .dblclick();
  check(
    (await source.inputValue()).includes("platform.system()"),
    "File Manager opens code saved to Linux",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Mobile desktop fits viewport",
  );
  await page.screenshot({ path: "screenshots/mobile-desktop.png" });
  await page.setViewportSize({ width: 1365, height: 900 });
  check(errors.length === 0, "No browser page errors");
  return { passed, count: passed.length, errors };
}
