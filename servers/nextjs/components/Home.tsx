"use client";
import React from "react";

export default function Home() {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900">Presenton Export Service</h1>
        <p className="text-gray-600 mt-2">Headless rendering service is running.</p>
        <p className="text-sm text-gray-500 mt-4">
          This instance is optimized for PDF/PPTX generation only.
          Interactive features are disabled.
        </p>
      </div>
    </div>
  );
}

