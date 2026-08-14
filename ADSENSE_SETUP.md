# 📢 AdSense Ad Units — IMPORTANT Setup Guide

## ⚠️ Read This Before Going Live

Aapki site pe ab **2 manual ad slots** add ho gaye hain (jo Auto Ads se 5-10x zyada earn karte hain):

1. **Below-hero ad** — Home page pe categories ke baad
2. **Mid-article ad** — Har blog post ke ~3rd paragraph ke baad (auto-injected by enhancements.js)

**Lekin ye ads tabhi actual earn karenge jab aap real AdSense slot IDs replace kar denge.**

Abhi placeholder `data-ad-slot="1234567890"` set hai — ye chalega nahi.

---

## 🛠️ Real Slot IDs Kaise Milte Hain?

### Step 1: AdSense Dashboard me Ad Units Banao

1. https://www.google.com/adsense/ open karo
2. Left sidebar → **Ads** → **By ad unit** → **Display ads**
3. **New ad unit** click karo → **Display ads** select karo
4. Ye 2 units banao:

   **Unit 1: "Below Hero"**
   - Name: `AIToolsNova - Below Hero`
   - Ad size: **Responsive** (default)
   - Ad type: Display, Text, Multiplex — sab on
   - **Create** click karo
   - Aapko ek code snippet milega, usme se **`data-ad-slot="XXXXXXXXXX"`** copy karo (10 digit number)

   **Unit 2: "In-Article"**
   - Name: `AIToolsNova - Blog In-Article`
   - Ad type: **In-article ad** select karo
   - **Create** click karo
   - Aapko dusra **`data-ad-slot="YYYYYYYYYY"`** milega

### Step 2: Slot IDs Ko Code me Replace Karo

**Fix 1: Below-Hero ad (index.html me)**

Open `/app/index.html`, dhundo:
```html
<ins class="adsbygoogle"
     style="display:block;min-height:90px;"
     data-ad-client="ca-pub-2278101269918728"
     data-ad-slot="1234567890"
```

`1234567890` ko **Unit 1** wale actual slot ID se replace karo.

**Fix 2: Mid-article ad (enhancements.js me)**

Open `/app/enhancements.js`, dhundo:
```javascript
data-ad-slot="1234567890"
data-ad-format="fluid"
data-ad-layout="in-article"
```

`1234567890` ko **Unit 2** wale actual in-article slot ID se replace karo.

### Step 3: GitHub pe push aur Cloudflare pe deploy

"Save to GitHub" → wait 2 min → live ho jayega.

---

## 💰 Expected Earnings Boost

- **Auto ads only**: ~$0.50-1.50 per 1000 pageviews
- **Auto + 2 manual slots**: ~$3-8 per 1000 pageviews (2-5x boost)
- **Mid-article performs best** kyunki reader engaged hota hai us position pe

---

## 🎯 Bonus: Aur Bhi Ad Placements Add Karne Hain?

Best positions for AdSense (agar aap manually add karna chahte ho):

1. ✅ **After first paragraph** — Highest RPM (already done via mid-article)
2. ✅ **After hero section** — Above-fold display (already done)
3. 🔹 **Sidebar sticky** — For desktop (needs sidebar layout)
4. 🔹 **End of article** — Before comments/related posts
5. 🔹 **Between H2 sections** — Every 500 words

Agar aur slots chahiye toh mujhe bolo, main add kar dunga.

---

## ⚠️ Ad Loading Test

Live site pe test karne ke liye:
1. Homepage khole in incognito
2. F12 (DevTools) → Console tab
3. Type: `document.querySelectorAll('.adsbygoogle').length` → should be 2+ 
4. Network tab me `pagead2.googlesyndication.com` se responses aane chahiye

Agar ads render nahi ho rahe:
- Sample text `data-adtest="on"` add karke test karo
- Real ads sirf **approved** AdSense accounts me hi dikhte hain

---

## 📚 References

- [AdSense Best Practices](https://support.google.com/adsense/answer/9184695)
- [Ad Placement Policies](https://support.google.com/adsense/answer/1346295)
- [In-Article Ads Guide](https://support.google.com/adsense/answer/9189957)
