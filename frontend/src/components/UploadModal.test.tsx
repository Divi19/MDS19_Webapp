import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import UploadModal from "@/components/UploadModal";

describe("HER2-scoped upload", () => {
  it("requires image scale and explicit tissue and stain confirmations", async () => {
    const onRun = vi.fn();
    const { container } = render(<UploadModal open onClose={vi.fn()} onRun={onRun} />);
    expect(screen.getByText("HER2-positive breast tissue only.")).toBeInTheDocument();
    const run = screen.getByRole("button", { name: "Run research prediction" });
    expect(run).toBeDisabled();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(["image"], "sample.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getAllByText(/sample.png/).length).toBeGreaterThan(0));
    fireEvent.change(screen.getByPlaceholderText("e.g. 0.50"), { target: { value: "0.5" } });
    const confirmations = screen.getAllByRole("checkbox");
    confirmations.forEach((checkbox) => fireEvent.click(checkbox));
    expect(run).toBeEnabled();
    fireEvent.click(run);
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({
      name: "sample.png",
      her2PositiveBreastTissueConfirmed: true,
      heStainConfirmed: true,
      micronsPerPixel: 0.5,
      syntheticDemo: false,
    }));
  });
});
