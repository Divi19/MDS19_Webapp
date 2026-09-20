import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ChatPanel from "@/components/ChatPanel";
import { predictionFixture } from "@/test/fixture";

describe("evidence reader panel", () => {
  it("is collapsible and routes quick prompts synchronously to returned evidence", () => {
    render(<ChatPanel prediction={predictionFixture()} />);
    expect(screen.queryByText(/No generative model/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Evidence reader/ }));
    expect(screen.getByText(/No generative model or external annotation/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Summarize domain_1" }));
    expect(screen.getByText(/domain_1 contains 2 tiles/)).toBeInTheDocument();
    expect(screen.getByText(/not measured markers, cell types, or validated biomarkers/)).toBeInTheDocument();
  });
});
