package signing

import (
	"strings"
	"testing"
)

const (
	treeSHA1   = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
	parentA    = "1111111111111111111111111111111111111111"
	parentB    = "2222222222222222222222222222222222222222"
	treeSHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"
	jeff       = "Jeff <Jeff@Lleverage.ai> 1764000000 +0000"
	alex       = "Alex <alex@lleverage.ai> 1764000000 +0100"
)

func commit(headers ...string) string {
	return strings.Join(headers, "\n") + "\n\nA message\n"
}

func TestParseGitObjectAcceptsCommits(t *testing.T) {
	mergetag := "mergetag object " + parentB + "\n type commit\n tag v1.0.0\n tagger " + alex + "\n \n Release v1.0.0\n -----BEGIN PGP SIGNATURE-----\n \n iQEz\n -----END PGP SIGNATURE-----"
	cases := map[string]struct {
		payload string
		object  string
	}{
		"standard":             {commit("tree "+treeSHA1, "parent "+parentA, "author "+jeff, "committer "+jeff), treeSHA1},
		"root":                 {commit("tree "+treeSHA1, "author "+jeff, "committer "+jeff), treeSHA1},
		"merge":                {commit("tree "+treeSHA1, "parent "+parentA, "parent "+parentB, "author "+jeff, "committer "+jeff), treeSHA1},
		"sha256":               {commit("tree "+treeSHA256, "parent "+treeSHA256, "author "+jeff, "committer "+jeff), treeSHA256},
		"encoding":             {commit("tree "+treeSHA1, "author "+jeff, "committer "+jeff, "encoding ISO-8859-1"), treeSHA1},
		"mergetag":             {commit("tree "+treeSHA1, "parent "+parentA, "parent "+parentB, "author "+jeff, "committer "+jeff, mergetag), treeSHA1},
		"change-id":            {commit("tree "+treeSHA1, "author "+jeff, "committer "+jeff, "change-id zvlkuxzlwyqnmqqlvnrrwnnwxstzsmkp"), treeSHA1},
		"empty body":           {"tree " + treeSHA1 + "\nauthor " + jeff + "\ncommitter " + jeff + "\n\n", treeSHA1},
		"multi-line body":      {"tree " + treeSHA1 + "\nauthor " + jeff + "\ncommitter " + jeff + "\n\nSubject\n\nBody line one.\nBody line two.\n\nSigned-off-by: Jeff <jeff@lleverage.ai>\n", treeSHA1},
		"author not committer": {commit("tree "+treeSHA1, "parent "+parentA, "author "+alex, "committer "+jeff), treeSHA1},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			obj, err := ParseGitObject([]byte(c.payload))
			if err != nil {
				t.Fatal(err)
			}
			if obj.Type != ObjectCommit || obj.CommitterEmail != "jeff@lleverage.ai" || obj.ObjectHash != c.object {
				t.Fatalf("%+v", obj)
			}
		})
	}
}

func TestParseGitObjectAcceptsAnnotatedTags(t *testing.T) {
	for _, typ := range []string{"commit", "tree", "blob", "tag"} {
		t.Run(typ, func(t *testing.T) {
			payload := "object " + parentA + "\ntype " + typ + "\ntag v1.2.3\ntagger " + jeff + "\n\nRelease v1.2.3\n"
			obj, err := ParseGitObject([]byte(payload))
			if err != nil {
				t.Fatal(err)
			}
			if obj.Type != ObjectTag || obj.CommitterEmail != "jeff@lleverage.ai" || obj.ObjectHash != parentA {
				t.Fatalf("%+v", obj)
			}
		})
	}
}

func TestParseGitObjectRefusesWhatIsntAnUnsignedCommitOrTag(t *testing.T) {
	good := []string{"tree " + treeSHA1, "parent " + parentA, "author " + jeff, "committer " + jeff}
	with := func(i int, line string) string {
		h := append([]string{}, good...)
		h[i] = line
		return commit(h...)
	}
	tag := "object " + parentA + "\ntype commit\ntag v1\ntagger " + jeff + "\n\nmsg\n"
	cases := map[string]string{
		"arbitrary text":        "please sign this\n",
		"email":                 "From: alex@lleverage.ai\nTo: bank@example.com\nSubject: transfer\n\nPay it.\n",
		"jwt":                   "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGV4In0.c2lnbmF0dXJl",
		"gpg challenge":         "-----BEGIN PGP MESSAGE-----\n\nhQEMA\n-----END PGP MESSAGE-----\n",
		"certificate":           "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
		"empty":                 "",
		"oversized":             commit(good...) + strings.Repeat("x", MaxPayloadBytes),
		"nul byte":              commit(good...) + "\x00",
		"no blank line":         strings.Join(good, "\n") + "\n",
		"short tree":            with(0, "tree abc"),
		"upper-case tree":       with(0, "tree "+strings.ToUpper(treeSHA1)),
		"bad parent":            with(1, "parent xyz"),
		"no name":               with(3, "committer <jeff@lleverage.ai> 1764000000 +0000"),
		"no email":              with(3, "committer Jeff 1764000000 +0000"),
		"email without @":       with(3, "committer Jeff <jeff> 1764000000 +0000"),
		"email with a space":    with(3, "committer Jeff <jeff @lleverage.ai> 1764000000 +0000"),
		"no timestamp":          with(3, "committer Jeff <jeff@lleverage.ai> +0000"),
		"bad timezone":          with(3, "committer Jeff <jeff@lleverage.ai> 1764000000 0000"),
		"name with <":           with(3, "committer Je<ff <jeff@lleverage.ai> 1764000000 +0000"),
		"missing committer":     commit("tree "+treeSHA1, "author "+jeff),
		"missing author":        commit("tree "+treeSHA1, "committer "+jeff),
		"committer twice":       commit(append(good, "committer "+jeff)...),
		"parent after author":   commit("tree "+treeSHA1, "author "+jeff, "parent "+parentA, "committer "+jeff),
		"gpgsig":                commit(append(good, "gpgsig -----BEGIN PGP SIGNATURE-----", " ", " iQEz", " -----END PGP SIGNATURE-----")...),
		"gpgsig-sha256":         commit(append(good, "gpgsig-sha256 -----BEGIN SSH SIGNATURE-----", " U1NI", " -----END SSH SIGNATURE-----")...),
		"unknown header":        commit(append(good, "x-anything yes")...),
		"stray continuation":    commit(append(good, " continued")...),
		"encoding twice":        commit(append(good, "encoding UTF-8", "encoding UTF-8")...),
		"malformed mergetag":    commit(append(good, "mergetag nonsense", " more")...),
		"signed tag":            "object " + parentA + "\ntype commit\ntag v1\ntagger " + jeff + "\n\nmsg\n-----BEGIN PGP SIGNATURE-----\n\niQEz\n-----END PGP SIGNATURE-----\n",
		"ssh-signed tag":        "object " + parentA + "\ntype commit\ntag v1\ntagger " + jeff + "\n\nmsg\n-----BEGIN SSH SIGNATURE-----\nU1NI\n-----END SSH SIGNATURE-----\n",
		"tag without tagger":    "object " + parentA + "\ntype commit\ntag v1\n\nmsg\n",
		"tag with a bad type":   strings.Replace(tag, "type commit", "type note", 1),
		"tag name with a space": strings.Replace(tag, "tag v1", "tag v 1", 1),
		"tag with extra header": strings.Replace(tag, "\n\nmsg", "\nencoding UTF-8\n\nmsg", 1),
		"tag out of order":      "type commit\nobject " + parentA + "\ntag v1\ntagger " + jeff + "\n\nmsg\n",
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			if obj, err := ParseGitObject([]byte(payload)); err == nil {
				t.Fatalf("accepted: %+v", obj)
			}
		})
	}
}
