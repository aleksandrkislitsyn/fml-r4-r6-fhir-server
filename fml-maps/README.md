This Repository is a temporary home for the FHIR Mapping Language (FML) maps from FHIR [R4](https://hl7.org/fhir/R4)/[R5](https://hl7.org/fhir/R5) to FHIR [R6-ballot5](https://hl7.org/fhir/6.0.0-ballot5)

The maps were generated using my [FML Generator tool](https://github.com/brianpos/fml-processor) and uses templates that are in that project:
* [R4-R6 property renames](https://github.com/brianpos/fml-processor/blob/main/fml-tester/testdata/r4-r6-renames.txt)
* [R4-R6 Custom Rules](https://github.com/brianpos/fml-processor/blob/main/fml-tester/testdata/r4-r6-custom-rules.fml)

They have been validated to ensure that all the properties are of the correct types and have maps.
Some of them have warnings indicating that further action is needed to ensure that the maps are correct.  The warnings are in the form of comments in the FML files.

These 2 files are manually edited from similar files in the R4-R5 maps previously created.
There may be some issues in here for type conversions that should be removed and specific manual rules where they are encountered.

* R4_R6\maps\StructureMaps\primitives4to6.fml
* R5_R6\maps\StructureMaps\primitives5to6.fml

> **NOTE:** These are not for production use, and only for review while in development.
> Once completed they will be moved into the [HL7 cross version repository](https://github.com/HL7/fhir-cross-version/tree/main/input).
