/**
 * Font loader hook for offline mode.
 * Loads fonts from local server instead of Google Fonts.
 */
export const useFontLoader = (fonts: string[]) => {
    const injectFonts = (fontUrls: string[]) => {
        fontUrls.forEach((fontUrl) => {
            if (!fontUrl) return;

            // Skip Google Fonts URLs in offline mode
            if (fontUrl.includes('fonts.googleapis')) {
                console.warn(`Skipping Google Font URL (offline mode): ${fontUrl}`);
                return;
            }

            // Use local server for font files
            // Construct local URL if it's a relative path
            let newFontUrl = fontUrl;
            if (fontUrl.startsWith('/app_data/') || fontUrl.startsWith('/static/')) {
                // Get the base URL from window.location or use default
                const baseUrl = typeof window !== 'undefined'
                    ? `${window.location.protocol}//${window.location.hostname}:5000`
                    : 'http://localhost:5000';
                newFontUrl = `${baseUrl}${fontUrl}`;
            } else if (!fontUrl.startsWith('http')) {
                // Handle relative paths
                const baseUrl = typeof window !== 'undefined'
                    ? `${window.location.protocol}//${window.location.hostname}:5000`
                    : 'http://localhost:5000';
                newFontUrl = `${baseUrl}${fontUrl.startsWith('/') ? '' : '/'}${fontUrl}`;
            }

            const existingStyle = document.querySelector(`style[data-font-url="${newFontUrl}"]`);
            if (existingStyle) return;

            const style = document.createElement("style");
            style.setAttribute("data-font-url", newFontUrl);

            // For local font files, use @font-face instead of @import
            if (newFontUrl.includes('/app_data/fonts/')) {
                // Extract font name from URL
                const fontFileName = newFontUrl.split('/').pop() || 'CustomFont';
                const fontName = fontFileName.replace(/\.[^.]+$/, '').replace(/_[a-f0-9]{8}$/, '');

                style.textContent = `
                    @font-face {
                        font-family: '${fontName}';
                        src: url('${newFontUrl}') format('truetype');
                        font-weight: normal;
                        font-style: normal;
                        font-display: swap;
                    }
                `;
            } else {
                style.textContent = `@import url('${newFontUrl}');`;
            }

            document.head.appendChild(style);
        });
    };

    injectFonts(fonts);
};